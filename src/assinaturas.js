// backend/src/assinaturas.js
// Sistema de assinatura com Mercado Pago — versão completa e profissional

'use strict';

const mercadopago = require('mercadopago');
const pool        = require('./database');
const cron        = require('node-cron');
const nodemailer  = require('nodemailer');

/* ─────────────────────────────────────────────────────────────
   CONFIGURAÇÃO — MERCADO PAGO
───────────────────────────────────────────────────────────── */
if (!process.env.MERCADO_PAGO_ACCESS_TOKEN) {
    console.warn('⚠️  MERCADO_PAGO_ACCESS_TOKEN não definido no .env');
}

mercadopago.configure({
    access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN || '',
});

/* ─────────────────────────────────────────────────────────────
   CONFIGURAÇÃO — E-MAIL (OPCIONAL)
───────────────────────────────────────────────────────────── */
const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
    },
});

/* ─────────────────────────────────────────────────────────────
   URLS BASE  (usa variável de ambiente; fallback para localhost)
───────────────────────────────────────────────────────────── */
const API_URL      = process.env.API_URL      || 'http://localhost:3001/api';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/* ─────────────────────────────────────────────────────────────
   HELPER — resposta de erro padronizada
───────────────────────────────────────────────────────────── */
const erroInterno = (res, msg, err) => {
    console.error(`❌ ${msg}:`, err?.message || err);
    return res.status(500).json({ erro: msg, detalhes: err?.message || null });
};

/* ─────────────────────────────────────────────────────────────
   1.  LISTAR PLANOS
───────────────────────────────────────────────────────────── */
async function listarPlanos(req, res) {
    try {
        const { tipo_conta } = req.query;

        let sql    = `SELECT id, nome, tipo_conta, preco, limite_alunos, descricao, recursos
                      FROM planos
                      WHERE ativo = true`;
        const vals = [];

        if (tipo_conta) {
            vals.push(tipo_conta);
            sql += ` AND tipo_conta = $${vals.length}`;
        }

        sql += ' ORDER BY tipo_conta, preco';

        const { rows } = await pool.query(sql, vals);
        return res.json(rows);
    } catch (err) {
        return erroInterno(res, 'Erro ao listar planos', err);
    }
}

/* ─────────────────────────────────────────────────────────────
   2.  CRIAR PREFERÊNCIA / NOVA ASSINATURA
───────────────────────────────────────────────────────────── */
async function criarAssinatura(req, res) {
    const { academia_id, plano_id, tipo_conta } = req.body;

    if (!academia_id || !plano_id || !tipo_conta) {
        return res.status(400).json({ erro: 'academia_id, plano_id e tipo_conta são obrigatórios' });
    }

    try {
        // Buscar plano
        const planoRes = await pool.query(
            'SELECT * FROM planos WHERE id = $1 AND tipo_conta = $2 AND ativo = true',
            [plano_id, tipo_conta]
        );
        if (planoRes.rows.length === 0) {
            return res.status(400).json({ erro: 'Plano inválido ou inativo para este tipo de conta' });
        }
        const plano = planoRes.rows[0];

        // Buscar academia
        const acadRes = await pool.query(
            'SELECT id, nome, email FROM academias WHERE id = $1',
            [academia_id]
        );
        if (acadRes.rows.length === 0) {
            return res.status(404).json({ erro: 'Academia não encontrada' });
        }
        const academia = acadRes.rows[0];

        const preference = {
            items: [{
                title:       `Plano ${plano.nome} — ${plano.tipo_conta}`,
                description: plano.descricao || `Acesso ao sistema por ${plano.duracao_dias || 30} dias`,
                quantity:    1,
                currency_id: 'BRL',
                unit_price:  parseFloat(plano.preco),
            }],
            payer: {
                name:  academia.nome,
                email: academia.email,
            },
            back_urls: {
                success: `${FRONTEND_URL}/dashboard`,
                failure: `${FRONTEND_URL}/planos`,
                pending: `${FRONTEND_URL}/planos`,
            },
            auto_return:           'approved',
            external_reference:    `${academia_id}_${plano_id}`,
            notification_url:      `${API_URL}/webhook/mercadopago`,
            statement_descriptor:  'GYMPRO',
        };

        const mpRes = await mercadopago.preferences.create(preference);

        return res.json({
            sucesso:       true,
            init_point:    mpRes.body.init_point,
            preference_id: mpRes.body.id,
        });

    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        return erroInterno(res, 'Erro ao criar assinatura', new Error(msg));
    }
}

/* ─────────────────────────────────────────────────────────────
   3.  RENOVAR ASSINATURA (mesmo fluxo MP, mas rota separada)
───────────────────────────────────────────────────────────── */
async function renovarAssinatura(req, res) {
    const { academia_id, plano_id } = req.body;

    if (!academia_id || !plano_id) {
        return res.status(400).json({ erro: 'academia_id e plano_id são obrigatórios' });
    }

    try {
        const planoRes = await pool.query(
            'SELECT * FROM planos WHERE id = $1 AND ativo = true',
            [plano_id]
        );
        if (planoRes.rows.length === 0) {
            return res.status(400).json({ erro: 'Plano não encontrado' });
        }
        const plano = planoRes.rows[0];

        const acadRes = await pool.query(
            'SELECT id, nome, email FROM academias WHERE id = $1',
            [academia_id]
        );
        if (acadRes.rows.length === 0) {
            return res.status(404).json({ erro: 'Academia não encontrada' });
        }
        const academia = acadRes.rows[0];

        const preference = {
            items: [{
                title:       `Renovação — ${plano.nome}`,
                description: `Renovação de assinatura GymPro`,
                quantity:    1,
                currency_id: 'BRL',
                unit_price:  parseFloat(plano.preco),
            }],
            payer: {
                name:  academia.nome,
                email: academia.email,
            },
            back_urls: {
                success: `${FRONTEND_URL}/dashboard`,
                failure: `${FRONTEND_URL}/assinatura`,
                pending: `${FRONTEND_URL}/assinatura`,
            },
            auto_return:        'approved',
            external_reference: `${academia_id}_${plano_id}`,
            notification_url:   `${API_URL}/webhook/mercadopago`,
        };

        const mpRes = await mercadopago.preferences.create(preference);

        return res.json({
            sucesso:       true,
            init_point:    mpRes.body.init_point,
            preference_id: mpRes.body.id,
        });

    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        return erroInterno(res, 'Erro ao renovar assinatura', new Error(msg));
    }
}

/* ─────────────────────────────────────────────────────────────
   4.  WEBHOOK — MERCADO PAGO
───────────────────────────────────────────────────────────── */
async function webhookMercadoPago(req, res) {
    // Responder imediatamente para o MP não retentar
    res.sendStatus(200);

    const { type, data } = req.body;
    console.log('📢 Webhook MP recebido:', JSON.stringify({ type, data }));

    if (type !== 'payment') return;

    try {
        const payment = await mercadopago.payment.get(data.id);
        const pBody   = payment.body;

        console.log(`💰 Payment ${data.id} — status: ${pBody.status}`);

        if (pBody.status !== 'approved') return;

        const externalRef          = pBody.external_reference || '';
        const [academia_id, plano_id] = externalRef.split('_');

        if (!academia_id || !plano_id) {
            console.error('❌ external_reference inválido:', externalRef);
            return;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Cancelar assinatura anterior
            await client.query(
                `UPDATE assinaturas SET status = 'cancelada'
                 WHERE academia_id = $1 AND status = 'ativa'`,
                [academia_id]
            );

            // Criar nova assinatura
            await client.query(
                `INSERT INTO assinaturas
                   (academia_id, plano_id, status, payment_id, data_pagamento, data_vencimento, notificado)
                 VALUES ($1, $2, 'ativa', $3, NOW(), NOW() + INTERVAL '30 days', false)`,
                [academia_id, plano_id, data.id]
            );

            // Atualizar academia
            await client.query(
                `UPDATE academias
                 SET plano_id              = $1,
                     assinatura_status     = 'ativa',
                     assinatura_vencimento = NOW() + INTERVAL '30 days',
                     trial_ativa           = false
                 WHERE id = $2`,
                [plano_id, academia_id]
            );

            // Registrar pagamento
            await client.query(
                `INSERT INTO pagamentos_assinatura
                   (academia_id, plano_id, valor, status, data_pagamento, data_vencimento, transaction_id)
                 VALUES ($1, $2, $3, 'pago', NOW(), NOW() + INTERVAL '30 days', $4)`,
                [academia_id, plano_id, pBody.transaction_amount, data.id]
            );

            await client.query('COMMIT');
            console.log(`✅ Assinatura ativada para academia ${academia_id}`);

        } catch (txErr) {
            await client.query('ROLLBACK');
            console.error('❌ Erro na transação do webhook:', txErr);
        } finally {
            client.release();
        }

    } catch (err) {
        console.error('❌ Erro ao processar webhook:', err);
    }
}

/* ─────────────────────────────────────────────────────────────
   5.  VERIFICAR STATUS DA ASSINATURA
───────────────────────────────────────────────────────────── */
async function verificarStatusAssinatura(req, res) {
    const { academia_id } = req.params;

    if (!academia_id) {
        return res.status(400).json({ erro: 'academia_id obrigatório' });
    }

    try {
        // Tentar buscar assinatura ativa
        const assinRes = await pool.query(
            `SELECT a.*, p.nome AS plano_nome, p.preco, p.limite_alunos, p.tipo_conta
             FROM assinaturas a
             JOIN planos p ON a.plano_id = p.id
             WHERE a.academia_id = $1 AND a.status = 'ativa'
             ORDER BY a.created_at DESC
             LIMIT 1`,
            [academia_id]
        );

        if (assinRes.rows.length === 0) {
            // Verificar se está em trial
            const acadRes = await pool.query(
                `SELECT trial_ativa, trial_vencimento FROM academias WHERE id = $1`,
                [academia_id]
            );

            if (acadRes.rows.length === 0) {
                return res.status(404).json({ erro: 'Academia não encontrada' });
            }

            const acad  = acadRes.rows[0];
            const hoje  = new Date();

            if (acad.trial_ativa && new Date(acad.trial_vencimento) > hoje) {
                const diasRestantes = Math.ceil(
                    (new Date(acad.trial_vencimento) - hoje) / 86_400_000
                );
                return res.json({
                    status:         'trial',
                    plano_nome:     'Trial',
                    preco:          0,
                    limite_alunos:  null,
                    dias_restantes: diasRestantes,
                    vencido:        false,
                    data_vencimento: acad.trial_vencimento,
                });
            }

            return res.json({
                status:         'sem_assinatura',
                plano_nome:     null,
                preco:          0,
                limite_alunos:  null,
                dias_restantes: 0,
                vencido:        true,
            });
        }

        const assin         = assinRes.rows[0];
        const hoje          = new Date();
        const vencimento    = new Date(assin.data_vencimento);
        const diasRestantes = Math.ceil((vencimento - hoje) / 86_400_000);
        const vencido       = vencimento < hoje;

        // Marcar como vencida se necessário
        if (vencido) {
            await pool.query(
                `UPDATE assinaturas SET status = 'vencida' WHERE id = $1`,
                [assin.id]
            );
            await pool.query(
                `UPDATE academias SET assinatura_status = 'vencida' WHERE id = $1`,
                [academia_id]
            );
        }

        return res.json({
            ...assin,
            dias_restantes: vencido ? 0 : diasRestantes,
            vencido,
        });

    } catch (err) {
        return erroInterno(res, 'Erro ao verificar assinatura', err);
    }
}

/* ─────────────────────────────────────────────────────────────
   6.  VERIFICAR LIMITE DE ALUNOS  (uso interno)
───────────────────────────────────────────────────────────── */
async function verificarLimiteAlunos(academia_id) {
    try {
        const { rows } = await pool.query(
            `SELECT p.limite_alunos, COUNT(c.id)::int AS total_alunos
             FROM academias a
             LEFT JOIN planos p ON a.plano_id = p.id
             LEFT JOIN clientes c ON c.academia_id = a.id AND c.ativo = true
             WHERE a.id = $1
             GROUP BY p.limite_alunos`,
            [academia_id]
        );

        if (rows.length === 0) return { pode_cadastrar: true };

        const { limite_alunos: limite, total_alunos: total } = rows[0];

        if (limite && total >= limite) {
            return {
                pode_cadastrar: false,
                limite,
                total,
                mensagem: `Limite de ${limite} alunos atingido. Faça upgrade do plano.`,
            };
        }

        return { pode_cadastrar: true, limite, total };

    } catch (err) {
        console.error('Erro ao verificar limite:', err);
        return { pode_cadastrar: true };   // fail-open
    }
}

/* ─────────────────────────────────────────────────────────────
   7.  JOB CRON — verificar assinaturas diariamente às 08:00
───────────────────────────────────────────────────────────── */
function iniciarJobVerificacaoAssinaturas() {
    cron.schedule('0 8 * * *', async () => {
        console.log('🔍 [CRON] Verificando assinaturas…');

        try {
            /* ── Notificar assinaturas vencendo em ≤ 7 dias ── */
            const { rows: vencendo } = await pool.query(
                `SELECT a.*, ac.nome, ac.email, ac.telefone, p.nome AS plano_nome, p.preco
                 FROM assinaturas a
                 JOIN academias ac ON a.academia_id = ac.id
                 JOIN planos p     ON a.plano_id    = p.id
                 WHERE a.status = 'ativa'
                   AND a.data_vencimento > NOW()
                   AND a.data_vencimento <= NOW() + INTERVAL '7 days'
                   AND a.notificado = false`
            );

            for (const assin of vencendo) {
                const diasRestantes = Math.ceil(
                    (new Date(assin.data_vencimento) - new Date()) / 86_400_000
                );

                if (process.env.SMTP_USER && process.env.SMTP_PASS) {
                    await enviarEmailNotificacao(assin, diasRestantes).catch(e =>
                        console.error(`❌ Email para ${assin.email}:`, e.message)
                    );
                }

                await pool.query(
                    'UPDATE assinaturas SET notificado = true WHERE id = $1',
                    [assin.id]
                );

                console.log(`📧 Notificação enviada para academia ${assin.academia_id} (${diasRestantes}d restantes)`);
            }

            /* ── Expirar assinaturas vencidas ── */
            const { rows: vencidas } = await pool.query(
                `SELECT a.id, a.academia_id
                 FROM assinaturas a
                 WHERE a.status = 'ativa' AND a.data_vencimento < NOW()`
            );

            for (const assin of vencidas) {
                await pool.query(
                    'UPDATE assinaturas SET status = $1 WHERE id = $2',
                    ['vencida', assin.id]
                );
                await pool.query(
                    'UPDATE academias SET assinatura_status = $1 WHERE id = $2',
                    ['vencida', assin.academia_id]
                );
            }

            console.log(
                `✅ [CRON] ${vencendo.length} notificadas · ${vencidas.length} expiradas`
            );

        } catch (err) {
            console.error('❌ [CRON] Erro na verificação de assinaturas:', err);
        }
    });

    console.log('⏰ Job de verificação de assinaturas agendado (08:00 diário)');
}

/* ─────────────────────────────────────────────────────────────
   8.  ENVIAR E-MAIL DE NOTIFICAÇÃO
───────────────────────────────────────────────────────────── */
async function enviarEmailNotificacao(assinatura, diasRestantes) {
    const mailOptions = {
        from:    process.env.SMTP_FROM || 'noreply@gympro.com',
        to:      assinatura.email,
        subject: `🔔 Sua assinatura GymPro vence em ${diasRestantes} dia${diasRestantes !== 1 ? 's' : ''}`,
        html: `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:#0b0c0e;padding:28px 32px">
      <h1 style="color:#e8ff47;margin:0;font-size:22px;letter-spacing:-.5px">GymPro</h1>
      <p style="color:#7e8290;margin:4px 0 0;font-size:13px">Plataforma de gestão para academias</p>
    </div>
    <div style="padding:32px">
      <p style="color:#0b0c0e;font-size:16px;margin:0 0 8px">Olá, <strong>${assinatura.nome}</strong> 👋</p>
      <p style="color:#454850;font-size:14px;line-height:1.6;margin:0 0 20px">
        Sua assinatura do plano <strong>${assinatura.plano_nome}</strong> vencerá em
        <strong>${diasRestantes} dia${diasRestantes !== 1 ? 's' : ''}</strong>.
        Renove agora para não perder o acesso ao sistema.
      </p>
      <a href="${FRONTEND_URL}/assinatura"
         style="display:inline-block;background:#e8ff47;color:#0b0c0e;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
        Renovar assinatura
      </a>
    </div>
    <div style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #eee">
      <p style="color:#999;font-size:12px;margin:0">
        Você está recebendo este e-mail porque possui uma conta no GymPro.<br>
        Em caso de dúvidas, entre em contato com nosso suporte.
      </p>
    </div>
  </div>
</body>
</html>`,
    };

    await transporter.sendMail(mailOptions);
}

/* ─────────────────────────────────────────────────────────────
   EXPORTS
───────────────────────────────────────────────────────────── */
module.exports = {
    listarPlanos,
    criarAssinatura,
    renovarAssinatura,
    webhookMercadoPago,
    verificarStatusAssinatura,
    verificarLimiteAlunos,
    iniciarJobVerificacaoAssinaturas,
};