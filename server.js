// backend/server.js
// Servidor principal GymPro — versão completa e profissional

'use strict';

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const pool     = require('./src/database');

const assinaturas          = require('./src/assinaturas');
const adminController      = require('./src/admin');
const verificarAssinatura  = require('./middleware/assinatura');

const app = express();

/* ─────────────────────────────────────────────────────────────
   CONFIGURAÇÕES GLOBAIS
───────────────────────────────────────────────────────────── */
const JWT_SECRET = process.env.JWT_SECRET;
const PORT       = parseInt(process.env.PORT, 10) || 3001;

if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET não definido no .env — encerrando.');
    process.exit(1);
}

/* ─────────────────────────────────────────────────────────────
   MIDDLEWARES GLOBAIS
───────────────────────────────────────────────────────────── */
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-academia-id', 'academia-id'],
}));

// Webhook do Mercado Pago precisa do raw body — registrar ANTES do express.json()
app.post('/api/webhook/mercadopago', express.raw({ type: 'application/json' }), (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
        try { req.body = JSON.parse(req.body.toString()); } catch { req.body = {}; }
    }
    next();
}, assinaturas.webhookMercadoPago);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */
const gerarToken = (payload, expiresIn = '7d') =>
    jwt.sign(payload, JWT_SECRET, { expiresIn });

const erroServidor = (res, msg, err) => {
    console.error(`❌ ${msg}:`, err?.message || err);
    return res.status(500).json({ erro: msg });
};

/* ─────────────────────────────────────────────────────────────
   HEALTH CHECK
───────────────────────────────────────────────────────────── */
app.get('/api/health', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

/* ═══════════════════════════════════════════════════════════
   AUTH — ACADEMIA (cadastro + login)
═══════════════════════════════════════════════════════════ */

/* ── Cadastro ── */
app.post('/api/academias/cadastro', async (req, res) => {
    const { nome, email, telefone, senha, tipo_conta } = req.body;

    if (!nome || !email || !senha) {
        return res.status(400).json({ erro: 'nome, email e senha são obrigatórios' });
    }

    try {
        const existe = await pool.query(
            'SELECT id FROM academias WHERE email = $1',
            [email.toLowerCase().trim()]
        );
        if (existe.rows.length > 0) {
            return res.status(409).json({ erro: 'E-mail já cadastrado' });
        }

        const codigo            = 'ACAD' + String(Math.floor(Math.random() * 90000) + 10000);
        const senhaHash         = await bcrypt.hash(senha, 12);
        const trialVencimento   = new Date(Date.now() + 14 * 86_400_000);

        const { rows } = await pool.query(
            `INSERT INTO academias
               (nome, email, telefone, senha_hash, codigo, tipo_conta, trial_ativa, trial_vencimento)
             VALUES ($1, $2, $3, $4, $5, $6, true, $7)
             RETURNING id, nome, codigo, tipo_conta`,
            [
                nome.trim(),
                email.toLowerCase().trim(),
                telefone || null,
                senhaHash,
                codigo,
                tipo_conta || 'academia',
                trialVencimento,
            ]
        );

        const academia = rows[0];

        localStorage_save: {
            // não há localStorage no backend — apenas geramos o token
        }

        const token = gerarToken({ id: academia.id, tipo: 'admin', nome: academia.nome });

        return res.status(201).json({
            sucesso: true,
            token,
            academia: {
                id:        academia.id,
                nome:      academia.nome,
                codigo:    academia.codigo,
                tipo_conta: academia.tipo_conta,
                trial_dias: 14,
            },
        });

    } catch (err) {
        return erroServidor(res, 'Erro ao cadastrar academia', err);
    }
});

/* ── Login admin ── */
app.post('/api/admin/login', async (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
        return res.status(400).json({ erro: 'email e senha são obrigatórios' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, nome, email, senha_hash
             FROM academias
             WHERE email = $1 AND ativo = true`,
            [email.toLowerCase().trim()]
        );

        if (rows.length === 0) {
            return res.status(401).json({ erro: 'E-mail não encontrado' });
        }

        const academia    = rows[0];
        const senhaValida = await bcrypt.compare(senha, academia.senha_hash);

        if (!senhaValida) {
            return res.status(401).json({ erro: 'Senha incorreta' });
        }

        const token = gerarToken({ id: academia.id, tipo: 'admin', nome: academia.nome });

        return res.json({
            sucesso: true,
            token,
            tipo: 'admin',
            academia: {
                id:    academia.id,
                nome:  academia.nome,
                email: academia.email,
            },
        });

    } catch (err) {
        return erroServidor(res, 'Erro no login', err);
    }
});

/* ── Login cliente ── */
app.post('/api/login', async (req, res) => {
    const { cpf, senha, codigo_academia } = req.body;

    if (!cpf || !senha || !codigo_academia) {
        return res.status(400).json({ erro: 'cpf, senha e codigo_academia são obrigatórios' });
    }

    try {
        const acadRes = await pool.query(
            'SELECT id, nome, tipo_conta FROM academias WHERE codigo = $1 AND ativo = true',
            [codigo_academia.toUpperCase().trim()]
        );

        if (acadRes.rows.length === 0) {
            return res.status(401).json({ erro: 'Código da academia inválido' });
        }

        const academia = acadRes.rows[0];

        const clienteRes = await pool.query(
            `SELECT id, nome, cpf, senha_hash, ativo
             FROM clientes
             WHERE cpf = $1 AND academia_id = $2`,
            [cpf.replace(/\D/g, ''), academia.id]
        );

        if (clienteRes.rows.length === 0) {
            return res.status(401).json({ erro: 'CPF não encontrado nesta academia' });
        }

        const cliente     = clienteRes.rows[0];
        const senhaValida = await bcrypt.compare(senha, cliente.senha_hash);

        if (!senhaValida) {
            return res.status(401).json({ erro: 'Senha incorreta' });
        }

        if (!cliente.ativo) {
            return res.status(403).json({ erro: 'Conta desativada. Procure a academia.' });
        }

        const token = gerarToken({
            id:           cliente.id,
            tipo:         'cliente',
            academia_id:  academia.id,
            academia_nome: academia.nome,
        });

        return res.json({
            sucesso: true,
            token,
            tipo: 'cliente',
            cliente: { id: cliente.id, nome: cliente.nome, cpf: cliente.cpf },
            academia: { id: academia.id, nome: academia.nome },
        });

    } catch (err) {
        return erroServidor(res, 'Erro no login', err);
    }
});

/* ── Validar token ── */
app.post('/api/validar-token', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ erro: 'Token não fornecido' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return res.json({ valido: true, usuario: decoded });
    } catch {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
});

/* ═══════════════════════════════════════════════════════════
   ACADEMIA — PERFIL
═══════════════════════════════════════════════════════════ */

/* ── Buscar código ── */
app.get('/api/academias/:id/codigo', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT codigo, nome FROM academias WHERE id = $1',
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ erro: 'Academia não encontrada' });
        return res.json(rows[0]);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar código', err);
    }
});

/* ── Buscar dados ── */
app.get('/api/academias/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, nome, email, telefone, logo_url, tipo_conta, codigo
             FROM academias
             WHERE id = $1`,
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ erro: 'Academia não encontrada' });
        return res.json(rows[0]);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar academia', err);
    }
});

/* ── Atualizar perfil ── */
app.put('/api/academias/:id', async (req, res) => {
    const { nome, telefone, logo_url } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });

    try {
        await pool.query(
            `UPDATE academias
             SET nome = $1, telefone = $2, logo_url = $3, updated_at = NOW()
             WHERE id = $4`,
            [nome.trim(), telefone || null, logo_url || null, req.params.id]
        );
        return res.json({ sucesso: true, mensagem: 'Dados atualizados com sucesso' });
    } catch (err) {
        return erroServidor(res, 'Erro ao atualizar academia', err);
    }
});

/* ═══════════════════════════════════════════════════════════
   ADMIN — CLIENTES
═══════════════════════════════════════════════════════════ */

/* ── Listar ── */
app.get('/api/admin/clientes', async (req, res) => {
    const { academia_id } = req.query;
    if (!academia_id) return res.status(400).json({ erro: 'academia_id obrigatório' });

    try {
        const { rows } = await pool.query(
            `SELECT
                c.id,
                c.nome,
                c.cpf,
                c.telefone,
                c.created_at,
                COALESCE(
                    (SELECT status FROM mensalidades
                     WHERE cliente_id = c.id ORDER BY data_vencimento DESC LIMIT 1),
                    'pendente'
                ) AS status_mensalidade,
                (SELECT data_vencimento FROM mensalidades
                 WHERE cliente_id = c.id ORDER BY data_vencimento DESC LIMIT 1) AS data_vencimento,
                COALESCE(
                    (SELECT valor FROM mensalidades
                     WHERE cliente_id = c.id ORDER BY data_vencimento DESC LIMIT 1),
                    100
                ) AS valor_mensalidade
             FROM clientes c
             WHERE c.academia_id = $1 AND c.ativo = true
             ORDER BY c.nome`,
            [academia_id]
        );
        return res.json(rows);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar clientes', err);
    }
});

/* ── Cadastrar ── */
app.post('/api/admin/clientes', async (req, res) => {
    const { academia_id, nome, cpf, senha, telefone, data_vencimento, valor_mensalidade } = req.body;

    if (!academia_id || !nome || !cpf || !senha) {
        return res.status(400).json({ erro: 'academia_id, nome, cpf e senha são obrigatórios' });
    }

    try {
        // Verificar limite do plano
        const limiteRes = await pool.query(
            `SELECT p.limite_alunos, COUNT(c.id)::int AS total
             FROM academias a
             LEFT JOIN planos p ON a.plano_id = p.id
             LEFT JOIN clientes c ON c.academia_id = a.id AND c.ativo = true
             WHERE a.id = $1
             GROUP BY p.limite_alunos`,
            [academia_id]
        );

        if (limiteRes.rows.length > 0) {
            const { limite_alunos: limite, total } = limiteRes.rows[0];
            if (limite && total >= limite) {
                return res.status(403).json({
                    erro:      'limite_atingido',
                    mensagem:  `Limite de ${limite} alunos atingido. Faça upgrade do plano para adicionar mais alunos.`,
                });
            }
        }

        // Verificar CPF duplicado na mesma academia
        const cpfLimpo = cpf.replace(/\D/g, '');
        const cpfExiste = await pool.query(
            'SELECT id FROM clientes WHERE cpf = $1 AND academia_id = $2',
            [cpfLimpo, academia_id]
        );
        if (cpfExiste.rows.length > 0) {
            return res.status(409).json({ erro: 'CPF já cadastrado nesta academia' });
        }

        const senhaHash = await bcrypt.hash(senha, 12);

        const { rows } = await pool.query(
            `INSERT INTO clientes (academia_id, nome, cpf, senha_hash, telefone)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, nome, cpf`,
            [academia_id, nome.trim(), cpfLimpo, senhaHash, telefone || null]
        );

        const clienteId  = rows[0].id;
        const vencimento = data_vencimento
            ? new Date(data_vencimento)
            : new Date(Date.now() + 30 * 86_400_000);

        await pool.query(
            `INSERT INTO mensalidades (cliente_id, data_vencimento, status, valor)
             VALUES ($1, $2, 'pendente', $3)`,
            [clienteId, vencimento.toISOString().split('T')[0], valor_mensalidade || 100]
        );

        return res.status(201).json({ sucesso: true, cliente: rows[0] });

    } catch (err) {
        return erroServidor(res, 'Erro ao cadastrar cliente', err);
    }
});

/* ── Editar ── */
app.put('/api/admin/clientes/:id', async (req, res) => {
    const { nome, telefone, cpf } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });

    try {
        const { rows } = await pool.query(
            `UPDATE clientes
             SET nome = $1, telefone = $2, cpf = $3, updated_at = NOW()
             WHERE id = $4
             RETURNING id, nome, cpf, telefone`,
            [nome.trim(), telefone || null, cpf?.replace(/\D/g, '') || null, req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado' });
        return res.json({ sucesso: true, cliente: rows[0] });
    } catch (err) {
        return erroServidor(res, 'Erro ao editar cliente', err);
    }
});

/* ── Excluir ── */
app.delete('/api/admin/clientes/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM agendamentos  WHERE cliente_id = $1', [id]);
        await client.query('DELETE FROM mensalidades  WHERE cliente_id = $1', [id]);
        await client.query('DELETE FROM clientes      WHERE id         = $1', [id]);
        await client.query('COMMIT');
        return res.json({ sucesso: true, mensagem: 'Cliente excluído' });
    } catch (err) {
        await client.query('ROLLBACK');
        return erroServidor(res, 'Erro ao excluir cliente', err);
    } finally {
        client.release();
    }
});

/* ── Histórico de mensalidades ── */
app.get('/api/admin/clientes/:id/historico', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, data_pagamento, data_vencimento, valor, status, forma_pagamento, created_at
             FROM mensalidades
             WHERE cliente_id = $1
             ORDER BY created_at DESC`,
            [req.params.id]
        );
        return res.json(rows);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar histórico', err);
    }
});

/* ── Mensalidade global ── */
app.put('/api/admin/clientes/valor-global', async (req, res) => {
    const { academia_id, valor_mensalidade } = req.body;

    if (!academia_id || !valor_mensalidade || Number(valor_mensalidade) <= 0) {
        return res.status(400).json({ erro: 'Dados inválidos' });
    }

    try {
        const { rowCount } = await pool.query(
            `UPDATE mensalidades
             SET valor = $1
             WHERE cliente_id IN (
                 SELECT id FROM clientes WHERE academia_id = $2 AND ativo = true
             )
             AND status = 'pendente'`,
            [Number(valor_mensalidade), Number(academia_id)]
        );
        return res.json({
            sucesso:    true,
            mensagem:   `${rowCount} mensalidade(s) atualizada(s)`,
            atualizadas: rowCount,
        });
    } catch (err) {
        return erroServidor(res, 'Erro ao atualizar valor global', err);
    }
});

/* ── Vencimento individual ── */
app.put('/api/admin/clientes/:id/vencimento', async (req, res) => {
    const { data_vencimento } = req.body;
    if (!data_vencimento) return res.status(400).json({ erro: 'data_vencimento obrigatória' });

    try {
        const { rows } = await pool.query(
            `SELECT id FROM mensalidades
             WHERE cliente_id = $1 AND status = 'pendente'
             ORDER BY data_vencimento DESC LIMIT 1`,
            [req.params.id]
        );

        if (rows.length === 0) {
            // Criar mensalidade pendente se não existir
            await pool.query(
                `INSERT INTO mensalidades (cliente_id, data_vencimento, status, valor)
                 VALUES ($1, $2, 'pendente', 100)`,
                [req.params.id, data_vencimento]
            );
        } else {
            await pool.query(
                'UPDATE mensalidades SET data_vencimento = $1 WHERE id = $2',
                [data_vencimento, rows[0].id]
            );
        }

        return res.json({ sucesso: true, mensagem: 'Vencimento atualizado' });
    } catch (err) {
        return erroServidor(res, 'Erro ao atualizar vencimento', err);
    }
});

/* ═══════════════════════════════════════════════════════════
   ADMIN — MENSALIDADES
═══════════════════════════════════════════════════════════ */

/* ── Registrar pagamento ── */
app.post('/api/admin/mensalidades/pagar', async (req, res) => {
    const { cliente_id, valor, forma_pagamento } = req.body;
    if (!cliente_id) return res.status(400).json({ erro: 'cliente_id obrigatório' });

    try {
        const { rows: pendentes } = await pool.query(
            `SELECT id, data_vencimento, valor
             FROM mensalidades
             WHERE cliente_id = $1 AND status = 'pendente'
             ORDER BY data_vencimento ASC
             LIMIT 1`,
            [cliente_id]
        );

        if (pendentes.length === 0) {
            return res.status(404).json({ erro: 'Nenhuma mensalidade pendente encontrada' });
        }

        const mensalidade          = pendentes[0];
        const dataBase             = new Date(mensalidade.data_vencimento);
        const proximoVencimento    = new Date(dataBase);
        proximoVencimento.setDate(proximoVencimento.getDate() + 30);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `UPDATE mensalidades
                 SET status = 'pago', data_pagamento = NOW(), forma_pagamento = $1
                 WHERE id = $2`,
                [forma_pagamento || 'dinheiro', mensalidade.id]
            );

            await client.query(
                `INSERT INTO mensalidades (cliente_id, data_vencimento, valor, status)
                 VALUES ($1, $2, $3, 'pendente')`,
                [cliente_id, proximoVencimento.toISOString().split('T')[0], valor || mensalidade.valor || 100]
            );

            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

        return res.json({
            sucesso:                 true,
            mensagem:                'Pagamento registrado com sucesso',
            nova_data_vencimento:    proximoVencimento.toISOString().split('T')[0],
        });

    } catch (err) {
        return erroServidor(res, 'Erro ao registrar pagamento', err);
    }
});

/* ── Cancelar pagamento ── */
app.post('/api/admin/mensalidades/cancelar', async (req, res) => {
    const { pagamento_id, cliente_id } = req.body;
    if (!pagamento_id || !cliente_id) {
        return res.status(400).json({ erro: 'pagamento_id e cliente_id são obrigatórios' });
    }

    try {
        const { rowCount } = await pool.query(
            `UPDATE mensalidades
             SET status = 'cancelado'
             WHERE id = $1 AND cliente_id = $2`,
            [pagamento_id, cliente_id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ erro: 'Pagamento não encontrado' });
        }

        // Garantir que existe ao menos uma mensalidade pendente
        const { rows: pendentes } = await pool.query(
            `SELECT id FROM mensalidades WHERE cliente_id = $1 AND status = 'pendente'`,
            [cliente_id]
        );

        if (pendentes.length === 0) {
            await pool.query(
                `INSERT INTO mensalidades (cliente_id, data_vencimento, status, valor)
                 VALUES ($1, CURRENT_DATE, 'pendente', 100)`,
                [cliente_id]
            );
        }

        return res.json({ sucesso: true, mensagem: 'Pagamento cancelado' });
    } catch (err) {
        return erroServidor(res, 'Erro ao cancelar pagamento', err);
    }
});

/* ── Consultar mensalidade do cliente (app mobile) ── */
app.get('/api/clientes/:id/mensalidade', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT status, data_vencimento, data_pagamento
             FROM mensalidades
             WHERE cliente_id = $1
             ORDER BY data_vencimento DESC LIMIT 1`,
            [req.params.id]
        );

        if (rows.length === 0) return res.json({ status: 'sem_mensalidade', dias_atraso: 0 });

        const vencimento  = new Date(rows[0].data_vencimento);
        const diasAtraso  = Math.floor((Date.now() - vencimento.getTime()) / 86_400_000);
        const podeAgendar = rows[0].status === 'pago' || diasAtraso <= 10;

        return res.json({
            status:          rows[0].status,
            data_vencimento: rows[0].data_vencimento,
            dias_atraso:     diasAtraso > 0 ? diasAtraso : 0,
            pode_agendar:    podeAgendar,
        });

    } catch (err) {
        return erroServidor(res, 'Erro ao verificar mensalidade', err);
    }
});

/* ═══════════════════════════════════════════════════════════
   ADMIN — HORÁRIOS
═══════════════════════════════════════════════════════════ */

app.get('/api/admin/horarios', async (req, res) => {
    const { academia_id } = req.query;
    if (!academia_id) return res.status(400).json({ erro: 'academia_id obrigatório' });

    try {
        const { rows } = await pool.query(
            `SELECT * FROM horarios
             WHERE academia_id = $1 AND ativo = true
             ORDER BY dia_semana, hora_inicio`,
            [academia_id]
        );
        return res.json(rows);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar horários', err);
    }
});

app.post('/api/admin/horarios', async (req, res) => {
    const { id, academia_id, dia_semana, hora_inicio, hora_fim, capacidade } = req.body;

    if (!academia_id || dia_semana === undefined || !hora_inicio || !hora_fim || !capacidade) {
        return res.status(400).json({ erro: 'Todos os campos são obrigatórios' });
    }

    try {
        if (id) {
            await pool.query(
                `UPDATE horarios
                 SET dia_semana = $1, hora_inicio = $2, hora_fim = $3, capacidade = $4
                 WHERE id = $5 AND academia_id = $6`,
                [dia_semana, hora_inicio, hora_fim, capacidade, id, academia_id]
            );
            return res.json({ sucesso: true, mensagem: 'Horário atualizado' });
        }

        const { rows } = await pool.query(
            `INSERT INTO horarios (academia_id, dia_semana, hora_inicio, hora_fim, capacidade)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [academia_id, dia_semana, hora_inicio, hora_fim, capacidade]
        );
        return res.status(201).json({ sucesso: true, horario_id: rows[0].id });

    } catch (err) {
        return erroServidor(res, 'Erro ao salvar horário', err);
    }
});

app.delete('/api/admin/horarios/:id', async (req, res) => {
    try {
        await pool.query('UPDATE horarios SET ativo = false WHERE id = $1', [req.params.id]);
        return res.json({ sucesso: true });
    } catch (err) {
        return erroServidor(res, 'Erro ao deletar horário', err);
    }
});

/* ═══════════════════════════════════════════════════════════
   ADMIN — AGENDAMENTOS
═══════════════════════════════════════════════════════════ */

app.get('/api/admin/agendamentos', async (req, res) => {
    const { academia_id, data } = req.query;
    if (!academia_id) return res.status(400).json({ erro: 'academia_id obrigatório' });

    try {
        let sql    = `
            SELECT a.id, a.data, a.status,
                   c.nome AS cliente_nome, c.cpf,
                   h.hora_inicio, h.hora_fim
            FROM agendamentos a
            JOIN clientes c ON a.cliente_id  = c.id
            JOIN horarios h ON a.horario_id  = h.id
            WHERE c.academia_id = $1`;
        const vals = [academia_id];

        if (data) {
            vals.push(data);
            sql += ` AND a.data = $${vals.length}`;
        }

        sql += ' ORDER BY a.data, h.hora_inicio';

        const { rows } = await pool.query(sql, vals);
        return res.json(rows);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar agendamentos', err);
    }
});

/* ═══════════════════════════════════════════════════════════
   CLIENTE — HORÁRIOS + AGENDAMENTOS (app mobile)
═══════════════════════════════════════════════════════════ */

app.get('/api/horarios', async (req, res) => {
    const { academia_id, data } = req.query;
    if (!academia_id || !data) {
        return res.status(400).json({ erro: 'academia_id e data são obrigatórios' });
    }

    try {
        const diaSemana = new Date(data + 'T12:00:00').getDay();   // evita problema de timezone

        const { rows: horarios } = await pool.query(
            `SELECT * FROM horarios
             WHERE academia_id = $1 AND dia_semana = $2 AND ativo = true
             ORDER BY hora_inicio`,
            [academia_id, diaSemana]
        );

        for (const h of horarios) {
            const { rows: ags } = await pool.query(
                `SELECT COUNT(*)::int AS total FROM agendamentos
                 WHERE horario_id = $1 AND data = $2 AND status = 'agendado'`,
                [h.id, data]
            );
            h.vagas_ocupadas     = ags[0].total;
            h.vagas_disponiveis  = h.capacidade - h.vagas_ocupadas;
        }

        return res.json(horarios);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar horários', err);
    }
});

app.post('/api/agendamentos', async (req, res) => {
    const { cliente_id, horario_id, data } = req.body;
    if (!cliente_id || !horario_id || !data) {
        return res.status(400).json({ erro: 'cliente_id, horario_id e data são obrigatórios' });
    }

    try {
        // Verificar mensalidade
        const { rows: mens } = await pool.query(
            `SELECT status, data_vencimento FROM mensalidades
             WHERE cliente_id = $1 ORDER BY data_vencimento DESC LIMIT 1`,
            [cliente_id]
        );

        if (mens.length > 0 && mens[0].status !== 'pago') {
            const diasAtraso = Math.floor(
                (Date.now() - new Date(mens[0].data_vencimento).getTime()) / 86_400_000
            );
            if (diasAtraso > 10) {
                return res.status(403).json({
                    erro: `Mensalidade atrasada há ${diasAtraso} dias. Regularize para agendar.`,
                });
            }
        }

        // Verificar capacidade
        const { rows: horarioRows } = await pool.query(
            'SELECT capacidade FROM horarios WHERE id = $1',
            [horario_id]
        );
        if (horarioRows.length === 0) {
            return res.status(404).json({ erro: 'Horário não encontrado' });
        }

        const { rows: ocupados } = await pool.query(
            `SELECT COUNT(*)::int AS total FROM agendamentos
             WHERE horario_id = $1 AND data = $2 AND status = 'agendado'`,
            [horario_id, data]
        );

        if (ocupados[0].total >= horarioRows[0].capacidade) {
            return res.status(409).json({ erro: 'Horário lotado!' });
        }

        // Verificar duplicidade
        const { rows: jaAgendado } = await pool.query(
            `SELECT id FROM agendamentos
             WHERE cliente_id = $1 AND horario_id = $2 AND data = $3 AND status = 'agendado'`,
            [cliente_id, horario_id, data]
        );
        if (jaAgendado.length > 0) {
            return res.status(409).json({ erro: 'Você já possui agendamento neste horário' });
        }

        const { rows } = await pool.query(
            `INSERT INTO agendamentos (cliente_id, horario_id, data, status)
             VALUES ($1, $2, $3, 'agendado') RETURNING id`,
            [cliente_id, horario_id, data]
        );

        return res.status(201).json({ sucesso: true, agendamento_id: rows[0].id });

    } catch (err) {
        return erroServidor(res, 'Erro ao agendar', err);
    }
});

app.get('/api/clientes/:id/agendamentos', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT a.id, a.data, a.status, h.hora_inicio, h.hora_fim
             FROM agendamentos a
             JOIN horarios h ON a.horario_id = h.id
             WHERE a.cliente_id = $1 AND a.data >= CURRENT_DATE
             ORDER BY a.data, h.hora_inicio`,
            [req.params.id]
        );
        return res.json(rows);
    } catch (err) {
        return erroServidor(res, 'Erro ao buscar agendamentos', err);
    }
});

app.delete('/api/agendamentos/:id', async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `UPDATE agendamentos SET status = 'cancelado' WHERE id = $1`,
            [req.params.id]
        );
        if (rowCount === 0) return res.status(404).json({ erro: 'Agendamento não encontrado' });
        return res.json({ sucesso: true, mensagem: 'Agendamento cancelado' });
    } catch (err) {
        return erroServidor(res, 'Erro ao cancelar agendamento', err);
    }
});

/* ═══════════════════════════════════════════════════════════
   ASSINATURA
═══════════════════════════════════════════════════════════ */
app.get ('/api/planos',                          assinaturas.listarPlanos);
app.post('/api/assinatura/criar',                assinaturas.criarAssinatura);
app.post('/api/assinatura/renovar',              assinaturas.renovarAssinatura);
app.get ('/api/assinatura/status/:academia_id',  assinaturas.verificarStatusAssinatura);

/* ═══════════════════════════════════════════════════════════
   SUPER ADMIN
═══════════════════════════════════════════════════════════ */
app.post('/api/super-admin/login',                         adminController.loginSuperAdmin);
app.get ('/api/super-admin/dashboard',                     adminController.dashboardSuperAdmin);
app.get ('/api/super-admin/academias',                     adminController.listarTodasAcademias);
app.get ('/api/super-admin/academias/:id',                 adminController.verDetalhesAcademia);
app.put ('/api/super-admin/academias/:id/status',          adminController.alterarStatusAcademia);
app.post('/api/super-admin/academias/:id/resetar-senha',   adminController.resetarSenhaAcademia);
app.get ('/api/super-admin/pagamentos',                    adminController.listarTodosPagamentos);
app.post('/api/super-admin/planos',                        adminController.gerenciarPlanos);
app.post('/api/super-admin/academias/:id/acesso-gratuito', adminController.darAcessoGratuito);
app.get ('/api/super-admin/estatisticas',                  adminController.estatisticasAvancadas);

/* ─────────────────────────────────────────────────────────────
   MIDDLEWARE DE ASSINATURA (ativar após validação)
   Descomente as linhas abaixo para proteger as rotas de admin
───────────────────────────────────────────────────────────── */
// app.use('/api/admin',       verificarAssinatura);
// app.use('/api/horarios',    verificarAssinatura);
// app.use('/api/agendamentos',verificarAssinatura);

/* ─────────────────────────────────────────────────────────────
   404 + ERRO GLOBAL
───────────────────────────────────────────────────────────── */
app.use((req, res) => {
    res.status(404).json({ erro: `Rota ${req.method} ${req.path} não encontrada` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('💥 Erro não tratado:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
});

/* ─────────────────────────────────────────────────────────────
   INICIALIZAR
───────────────────────────────────────────────────────────── */
assinaturas.iniciarJobVerificacaoAssinaturas();

app.listen(PORT, () => {
    console.log(`🚀 GymPro API rodando na porta ${PORT}`);
    console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Frontend: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
});

module.exports = app;   // útil para testes