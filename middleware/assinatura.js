// backend/middleware/assinatura.js
// Middleware de verificação de assinatura — versão profissional

'use strict';

const pool = require('../src/database');

/* ─────────────────────────────────────────────────────────────
   Rotas que NÃO precisam de assinatura ativa
───────────────────────────────────────────────────────────── */
const ROTAS_PUBLICAS = [
    '/api/admin/login',
    '/api/academias/cadastro',
    '/api/login',
    '/api/planos',
    '/api/webhook/mercadopago',
    '/api/assinatura/criar',
    '/api/assinatura/renovar',
    '/api/assinatura/status',
    '/api/super-admin/login',
    '/api/validar-token',
    '/api/academias/',
];

/* ─────────────────────────────────────────────────────────────
   Helper — extrai academia_id de várias origens
───────────────────────────────────────────────────────────── */
function extrairAcademiaId(req) {
    return (
        req.headers['x-academia-id'] ||
        req.headers['academia-id']   ||
        req.body?.academia_id        ||
        req.query?.academia_id       ||
        req.params?.academia_id      ||
        null
    );
}

/* ─────────────────────────────────────────────────────────────
   MIDDLEWARE PRINCIPAL
───────────────────────────────────────────────────────────── */
async function verificarAssinatura(req, res, next) {

    // 1. Rota pública → passa direto
    const rotaPublica = ROTAS_PUBLICAS.some(rota => req.path.startsWith(rota));
    if (rotaPublica) return next();

    // 2. Extrair academia_id
    const academia_id = extrairAcademiaId(req);
    if (!academia_id) {
        // Sem academia_id não é possível verificar — deixa passar
        // (rotas que precisam vão falhar por conta própria)
        return next();
    }

    try {
        const { rows } = await pool.query(
            `SELECT id,
                    assinatura_status,
                    assinatura_vencimento,
                    trial_ativa,
                    trial_vencimento,
                    plano_id
             FROM academias
             WHERE id = $1`,
            [academia_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                erro:     'academia_nao_encontrada',
                mensagem: 'Academia não encontrada.',
            });
        }

        const acad = rows[0];
        const hoje = new Date();

        /* ── Trial ativo ── */
        if (acad.trial_ativa) {
            const trialVencimento = new Date(acad.trial_vencimento);

            if (trialVencimento > hoje) {
                const diasRestantes = Math.ceil((trialVencimento - hoje) / 86_400_000);
                console.log(`🔓 [Middleware] Academia ${academia_id} em trial — ${diasRestantes}d restantes`);
                return next();
            }

            // Trial expirado — desativar silenciosamente
            await pool.query(
                'UPDATE academias SET trial_ativa = false WHERE id = $1',
                [academia_id]
            );
            console.log(`⚠️  [Middleware] Trial expirado para academia ${academia_id}`);
        }

        /* ── Assinatura ── */
        if (acad.assinatura_status !== 'ativa') {
            return res.status(403).json({
                erro:         'assinatura_inativa',
                mensagem:     'Sua assinatura está vencida ou inativa. Renove para continuar.',
                redirect_url: '/assinatura',
            });
        }

        if (!acad.assinatura_vencimento) {
            return res.status(403).json({
                erro:         'assinatura_sem_vencimento',
                mensagem:     'Data de vencimento não encontrada. Entre em contato com o suporte.',
                redirect_url: '/assinatura',
            });
        }

        const vencimento = new Date(acad.assinatura_vencimento);

        if (vencimento < hoje) {
            // Marcar como vencida no banco
            await pool.query(
                `UPDATE academias
                 SET assinatura_status = 'vencida'
                 WHERE id = $1`,
                [academia_id]
            );
            await pool.query(
                `UPDATE assinaturas
                 SET status = 'vencida'
                 WHERE academia_id = $1 AND status = 'ativa'`,
                [academia_id]
            );

            return res.status(403).json({
                erro:         'assinatura_expirada',
                mensagem:     'Sua assinatura expirou. Renove para continuar usando o sistema.',
                redirect_url: '/assinatura',
            });
        }

        const diasRestantes = Math.ceil((vencimento - hoje) / 86_400_000);
        console.log(`✅ [Middleware] Academia ${academia_id} OK — ${diasRestantes}d restantes`);

        // Expor dias restantes para as rotas subsequentes (opcional)
        req.assinatura = { diasRestantes, vencimento };

        return next();

    } catch (err) {
        console.error('❌ [Middleware] Erro ao verificar assinatura:', err);
        return res.status(500).json({
            erro:     'erro_interno',
            mensagem: 'Erro ao verificar assinatura. Tente novamente.',
        });
    }
}

module.exports = verificarAssinatura;