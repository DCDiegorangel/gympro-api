// backend/src/admin.js
// Rotas para o Painel Super Admin (seu controle)

const pool = require('./database');
const bcrypt = require('bcrypt');

// ============================================
// 1. LOGIN DO SUPER ADMIN
// ============================================
async function loginSuperAdmin(req, res) {
    const { email, senha } = req.body;
    
    try {
        const admin = await pool.query(
            'SELECT * FROM super_admin WHERE email = $1 AND ativo = true',
            [email]
        );
        
        if (admin.rows.length === 0) {
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }
        
        const senhaValida = await bcrypt.compare(senha, admin.rows[0].senha_hash);
        
        if (!senhaValida) {
            return res.status(401).json({ erro: 'Credenciais inválidas' });
        }
        
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { id: admin.rows[0].id, tipo: 'super_admin', email: admin.rows[0].email },
            process.env.JWT_SECRET || 'super-secret',
            { expiresIn: '7d' }
        );
        
        res.json({
            sucesso: true,
            token,
            admin: {
                id: admin.rows[0].id,
                nome: admin.rows[0].nome,
                email: admin.rows[0].email
            }
        });
        
    } catch (error) {
        console.error('Erro no login super admin:', error);
        res.status(500).json({ erro: 'Erro no login' });
    }
}

// ============================================
// 2. DASHBOARD SUPER ADMIN (métricas globais)
// ============================================
async function dashboardSuperAdmin(req, res) {
    try {
        // Total de academias
        const totalAcademias = await pool.query(
            'SELECT COUNT(*) as total FROM academias'
        );
        
        // Academias por tipo
        const academiasPorTipo = await pool.query(
            `SELECT tipo_conta, COUNT(*) as total 
             FROM academias 
             GROUP BY tipo_conta`
        );
        
        // Faturamento do mês
        const faturamentoMes = await pool.query(
            `SELECT COALESCE(SUM(valor), 0) as total 
             FROM pagamentos_assinatura 
             WHERE EXTRACT(MONTH FROM data_pagamento) = EXTRACT(MONTH FROM NOW())
             AND EXTRACT(YEAR FROM data_pagamento) = EXTRACT(YEAR FROM NOW())
             AND status = 'pago'`
        );
        
        // Faturamento total
        const faturamentoTotal = await pool.query(
            'SELECT COALESCE(SUM(valor), 0) as total FROM pagamentos_assinatura WHERE status = "pago"'
        );
        
        // Assinaturas ativas vs vencidas
        const statusAssinaturas = await pool.query(
            `SELECT assinatura_status, COUNT(*) as total 
             FROM academias 
             GROUP BY assinatura_status`
        );
        
        // Novas academias no mês
        const novasAcademias = await pool.query(
            `SELECT COUNT(*) as total 
             FROM academias 
             WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW())
             AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())`
        );
        
        // Churn (cancelamentos no mês)
        const churn = await pool.query(
            `SELECT COUNT(*) as total 
             FROM academias 
             WHERE assinatura_status = 'cancelada'
             AND EXTRACT(MONTH FROM updated_at) = EXTRACT(MONTH FROM NOW())`
        );
        
        // Receita por plano
        const receitaPorPlano = await pool.query(
            `SELECT p.nome, COUNT(pa.id) as total_pagamentos, SUM(pa.valor) as total_receita
             FROM pagamentos_assinatura pa
             JOIN planos p ON pa.plano_id = p.id
             WHERE EXTRACT(MONTH FROM pa.data_pagamento) = EXTRACT(MONTH FROM NOW())
             GROUP BY p.nome
             ORDER BY total_receita DESC`
        );
        
        res.json({
            total_academias: parseInt(totalAcademias.rows[0].total),
            academias_por_tipo: academiasPorTipo.rows,
            faturamento_mes: parseFloat(faturamentoMes.rows[0].total),
            faturamento_total: parseFloat(faturamentoTotal.rows[0].total),
            status_assinaturas: statusAssinaturas.rows,
            novas_academias_mes: parseInt(novasAcademias.rows[0].total),
            churn_mes: parseInt(churn.rows[0].total),
            receita_por_plano: receitaPorPlano.rows
        });
        
    } catch (error) {
        console.error('Erro no dashboard:', error);
        res.status(500).json({ erro: 'Erro ao carregar dashboard' });
    }
}

// ============================================
// 3. LISTAR TODAS ACADEMIAS (super admin)
// ============================================
async function listarTodasAcademias(req, res) {
    const { page = 1, limit = 20, status, tipo_conta } = req.query;
    const offset = (page - 1) * limit;
    
    try {
        let query = `
            SELECT a.*, p.nome as plano_nome, p.preco
            FROM academias a
            LEFT JOIN planos p ON a.plano_id = p.id
            WHERE 1=1
        `;
        let params = [];
        
        if (status) {
            query += ` AND a.assinatura_status = $${params.length + 1}`;
            params.push(status);
        }
        
        if (tipo_conta) {
            query += ` AND a.tipo_conta = $${params.length + 1}`;
            params.push(tipo_conta);
        }
        
        query += ` ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const academias = await pool.query(query, params);
        
        const total = await pool.query(
            `SELECT COUNT(*) as total FROM academias`,
            []
        );
        
        res.json({
            academias: academias.rows,
            total: parseInt(total.rows[0].total),
            page: parseInt(page),
            limit: parseInt(limit)
        });
        
    } catch (error) {
        console.error('Erro ao listar academias:', error);
        res.status(500).json({ erro: 'Erro ao listar academias' });
    }
}

// ============================================
// 4. VER DETALHES DE UMA ACADEMIA
// ============================================
async function verDetalhesAcademia(req, res) {
    const { id } = req.params;
    
    try {
        const academia = await pool.query(
            `SELECT a.*, p.nome as plano_nome, p.preco, p.limite_alunos
             FROM academias a
             LEFT JOIN planos p ON a.plano_id = p.id
             WHERE a.id = $1`,
            [id]
        );
        
        if (academia.rows.length === 0) {
            return res.status(404).json({ erro: 'Academia não encontrada' });
        }
        
        const totalAlunos = await pool.query(
            'SELECT COUNT(*) as total FROM clientes WHERE academia_id = $1',
            [id]
        );
        
        const ultimoPagamento = await pool.query(
            `SELECT * FROM pagamentos_assinatura 
             WHERE academia_id = $1 
             ORDER BY data_pagamento DESC 
             LIMIT 1`,
            [id]
        );
        
        const historicoPagamentos = await pool.query(
            `SELECT * FROM pagamentos_assinatura 
             WHERE academia_id = $1 
             ORDER BY data_pagamento DESC 
             LIMIT 10`,
            [id]
        );
        
        res.json({
            ...academia.rows[0],
            total_alunos: parseInt(totalAlunos.rows[0].total),
            ultimo_pagamento: ultimoPagamento.rows[0] || null,
            historico_pagamentos: historicoPagamentos.rows
        });
        
    } catch (error) {
        console.error('Erro ao ver detalhes:', error);
        res.status(500).json({ erro: 'Erro ao ver detalhes' });
    }
}

// ============================================
// 5. BLOQUEAR/DESBLOQUEAR ACADEMIA
// ============================================
async function alterarStatusAcademia(req, res) {
    const { id } = req.params;
    const { acao } = req.body; // 'bloquear' ou 'desbloquear'
    
    try {
        let novoStatus;
        let mensagem;
        
        if (acao === 'bloquear') {
            novoStatus = 'bloqueada';
            mensagem = 'Academia bloqueada com sucesso';
        } else if (acao === 'desbloquear') {
            novoStatus = 'ativa';
            mensagem = 'Academia desbloqueada com sucesso';
        } else {
            return res.status(400).json({ erro: 'Ação inválida' });
        }
        
        await pool.query(
            'UPDATE academias SET assinatura_status = $1 WHERE id = $2',
            [novoStatus, id]
        );
        
        res.json({ sucesso: true, mensagem });
        
    } catch (error) {
        console.error('Erro ao alterar status:', error);
        res.status(500).json({ erro: 'Erro ao alterar status' });
    }
}

// ============================================
// 6. RESETAR SENHA DA ACADEMIA
// ============================================
async function resetarSenhaAcademia(req, res) {
    const { id } = req.params;
    const { nova_senha } = req.body;
    
    try {
        const senhaHash = await bcrypt.hash(nova_senha, 10);
        
        await pool.query(
            'UPDATE academias SET senha_hash = $1 WHERE id = $2',
            [senhaHash, id]
        );
        
        res.json({ sucesso: true, mensagem: 'Senha resetada com sucesso' });
        
    } catch (error) {
        console.error('Erro ao resetar senha:', error);
        res.status(500).json({ erro: 'Erro ao resetar senha' });
    }
}

// ============================================
// 7. LISTAR TODOS PAGAMENTOS (super admin)
// ============================================
async function listarTodosPagamentos(req, res) {
    const { page = 1, limit = 20, status, mes, ano } = req.query;
    const offset = (page - 1) * limit;
    
    try {
        let query = `
            SELECT pa.*, a.nome as academia_nome, a.email, p.nome as plano_nome
            FROM pagamentos_assinatura pa
            JOIN academias a ON pa.academia_id = a.id
            JOIN planos p ON pa.plano_id = p.id
            WHERE 1=1
        `;
        let params = [];
        
        if (status) {
            query += ` AND pa.status = $${params.length + 1}`;
            params.push(status);
        }
        
        if (mes) {
            query += ` AND EXTRACT(MONTH FROM pa.data_pagamento) = $${params.length + 1}`;
            params.push(mes);
        }
        
        if (ano) {
            query += ` AND EXTRACT(YEAR FROM pa.data_pagamento) = $${params.length + 1}`;
            params.push(ano);
        }
        
        query += ` ORDER BY pa.data_pagamento DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const pagamentos = await pool.query(query, params);
        
        const total = await pool.query(
            `SELECT COUNT(*) as total FROM pagamentos_assinatura`,
            []
        );
        
        res.json({
            pagamentos: pagamentos.rows,
            total: parseInt(total.rows[0].total),
            page: parseInt(page),
            limit: parseInt(limit)
        });
        
    } catch (error) {
        console.error('Erro ao listar pagamentos:', error);
        res.status(500).json({ erro: 'Erro ao listar pagamentos' });
    }
}

// ============================================
// 8. CRIAR/EDITAR PLANOS (super admin)
// ============================================
async function gerenciarPlanos(req, res) {
    const { id, nome, tipo_conta, preco, limite_alunos, duracao_dias, descricao, recursos } = req.body;
    
    try {
        if (id) {
            // Editar plano existente
            await pool.query(
                `UPDATE planos 
                 SET nome = $1, tipo_conta = $2, preco = $3, limite_alunos = $4, 
                     duracao_dias = $5, descricao = $6, recursos = $7, updated_at = NOW()
                 WHERE id = $8`,
                [nome, tipo_conta, preco, limite_alunos, duracao_dias, descricao, recursos, id]
            );
            res.json({ sucesso: true, mensagem: 'Plano atualizado' });
        } else {
            // Criar novo plano
            const result = await pool.query(
                `INSERT INTO planos (nome, tipo_conta, preco, limite_alunos, duracao_dias, descricao, recursos, ativo)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, true)
                 RETURNING id`,
                [nome, tipo_conta, preco, limite_alunos, duracao_dias, descricao, recursos]
            );
            res.json({ sucesso: true, mensagem: 'Plano criado', id: result.rows[0].id });
        }
        
    } catch (error) {
        console.error('Erro ao gerenciar plano:', error);
        res.status(500).json({ erro: 'Erro ao gerenciar plano' });
    }
}

// ============================================
// 9. DAR ACESSO GRATUITO (trial estendido)
// ============================================
async function darAcessoGratuito(req, res) {
    const { id } = req.params;
    const { dias } = req.body;
    
    try {
        await pool.query(
            `UPDATE academias 
             SET trial_ativa = true, 
                 trial_vencimento = NOW() + INTERVAL '${dias} days',
                 assinatura_status = 'ativa'
             WHERE id = $1`,
            [id]
        );
        
        res.json({ sucesso: true, mensagem: `Acesso gratuito por ${dias} dias concedido` });
        
    } catch (error) {
        console.error('Erro ao dar acesso gratuito:', error);
        res.status(500).json({ erro: 'Erro ao dar acesso gratuito' });
    }
}

// ============================================
// 10. ESTATÍSTICAS AVANÇADAS
// ============================================
async function estatisticasAvancadas(req, res) {
    try {
        // Crescimento mensal
        const crescimentoMensal = await pool.query(
            `SELECT 
                DATE_TRUNC('month', created_at) as mes,
                COUNT(*) as novas_academias,
                SUM(CASE WHEN assinatura_status = 'ativa' THEN 1 ELSE 0 END) as ativas
             FROM academias
             WHERE created_at >= NOW() - INTERVAL '6 months'
             GROUP BY DATE_TRUNC('month', created_at)
             ORDER BY mes DESC`
        );
        
        // Ticket médio
        const ticketMedio = await pool.query(
            `SELECT 
                EXTRACT(MONTH FROM data_pagamento) as mes,
                AVG(valor) as ticket_medio
             FROM pagamentos_assinatura
             WHERE data_pagamento >= NOW() - INTERVAL '6 months'
             GROUP BY EXTRACT(MONTH FROM data_pagamento)
             ORDER BY mes DESC`
        );
        
        // Planos mais vendidos
        const planosMaisVendidos = await pool.query(
            `SELECT p.nome, p.tipo_conta, COUNT(pa.id) as total_vendas
             FROM pagamentos_assinatura pa
             JOIN planos p ON pa.plano_id = p.id
             GROUP BY p.nome, p.tipo_conta
             ORDER BY total_vendas DESC
             LIMIT 5`
        );
        
        res.json({
            crescimento_mensal: crescimentoMensal.rows,
            ticket_medio: ticketMedio.rows,
            planos_mais_vendidos: planosMaisVendidos.rows
        });
        
    } catch (error) {
        console.error('Erro nas estatísticas:', error);
        res.status(500).json({ erro: 'Erro ao carregar estatísticas' });
    }
}

module.exports = {
    loginSuperAdmin,
    dashboardSuperAdmin,
    listarTodasAcademias,
    verDetalhesAcademia,
    alterarStatusAcademia,
    resetarSenhaAcademia,
    listarTodosPagamentos,
    gerenciarPlanos,
    darAcessoGratuito,
    estatisticasAvancadas
};