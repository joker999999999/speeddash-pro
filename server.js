const path = require('path');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const rootDir = __dirname;
const port = Number(process.env.PORT) || 3000;
const configuredBaseUrl = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
const allowedOriginsFromEnv = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

const directPaymentLinks = {
    sbp: process.env.PAYMENT_LINK_SBP || '',
    mir: process.env.PAYMENT_LINK_MIR || '',
    crypto: process.env.PAYMENT_LINK_CRYPTO || ''
};

const validMethods = new Set(['sbp', 'visa', 'mastercard', 'mir', 'card', 'crypto']);
let stripeClient = null;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(rootDir, { extensions: ['html'] }));

function normalizeOrigin(value) {
    try {
        const url = new URL(String(value || '').trim());
        return `${url.protocol}//${url.host}`;
    } catch {
        return '';
    }
}

function getAllowedOrigins() {
    const origins = new Set(allowedOriginsFromEnv.map(normalizeOrigin).filter(Boolean));
    if (configuredBaseUrl) {
        const normalizedBase = normalizeOrigin(configuredBaseUrl);
        if (normalizedBase) {
            origins.add(normalizedBase);
        }
    }
    return origins;
}

function resolveAppOrigin(req) {
    const headerOrigin = normalizeOrigin(req.headers.origin || '');
    const allowedOrigins = getAllowedOrigins();

    if (headerOrigin && (allowedOrigins.size === 0 || allowedOrigins.has(headerOrigin))) {
        return headerOrigin;
    }

    if (configuredBaseUrl) {
        return normalizeOrigin(configuredBaseUrl);
    }

    return `http://localhost:${port}`;
}

function getStripeClient() {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY не задан');
    }

    if (!stripeClient) {
        const Stripe = require('stripe');
        stripeClient = new Stripe(secretKey, { apiVersion: '2024-06-20' });
    }

    return stripeClient;
}

function resolveCurrency(currency) {
    return currency === 'rub' ? 'rub' : 'usd';
}

function assertPaymentPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Некорректный payload платежа');
    }

    const method = String(payload.method || '').toLowerCase();
    if (!validMethods.has(method)) {
        throw new Error('Неподдерживаемый способ оплаты');
    }

    const amount = Number(payload.amount);
    if (!Number.isInteger(amount) || amount < 100 || amount > 100000000) {
        throw new Error('Сумма должна быть в диапазоне от 1.00 до 1 000 000.00');
    }

    return {
        amount,
        currency: resolveCurrency(String(payload.currency || 'usd').toLowerCase()),
        method
    };
}

function buildPaymentLink(template, data) {
    return template
        .replaceAll('{amount}', encodeURIComponent(String(data.amount)))
        .replaceAll('{currency}', encodeURIComponent(data.currency))
        .replaceAll('{method}', encodeURIComponent(data.method));
}

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.post('/api/create-payment-session', async (req, res) => {
    try {
        const { amount, currency, method } = assertPaymentPayload(req.body);
        const isStripeMethod = method === 'visa' || method === 'mastercard' || method === 'card';

        if (isStripeMethod) {
            const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
            if (!publishableKey) {
                throw new Error('STRIPE_PUBLISHABLE_KEY не задан');
            }

            const origin = resolveAppOrigin(req);
            const successUrl = process.env.STRIPE_SUCCESS_URL || `${origin}/index.html?payment=success`;
            const cancelUrl = process.env.STRIPE_CANCEL_URL || `${origin}/index.html?payment=cancel`;

            const stripe = getStripeClient();
            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                payment_method_types: ['card'],
                line_items: [
                    {
                        quantity: 1,
                        price_data: {
                            currency,
                            unit_amount: amount,
                            product_data: {
                                name: 'Support SpeedDash Pro',
                                description: `Donation via ${method}`
                            }
                        }
                    }
                ],
                success_url: successUrl,
                cancel_url: cancelUrl,
                metadata: {
                    source: 'speeddash-pro',
                    method
                }
            });

            return res.json({
                provider: 'stripe',
                sessionId: session.id,
                publishableKey
            });
        }

        const paymentTemplate = directPaymentLinks[method];
        if (!paymentTemplate) {
            throw new Error(`Для способа "${method}" не задана ссылка оплаты в .env`);
        }

        return res.json({
            provider: 'link',
            url: buildPaymentLink(paymentTemplate, { amount, currency, method })
        });
    } catch (error) {
        return res.status(400).json({
            error: error.message || 'Не удалось создать платеж'
        });
    }
});

app.post('/share', (req, res) => {
    const title = String(req.body.title || '');
    const text = String(req.body.text || '');
    const url = String(req.body.url || '');
    const params = new URLSearchParams({ shared: '1', title, text, url });
    res.redirect(`/index.html?${params.toString()}`);
});

app.get('*', (_req, res) => {
    res.sendFile(path.join(rootDir, 'index.html'));
});

app.listen(port, () => {
    console.log(`SpeedDash Pro web server listening on http://localhost:${port}`);
});
