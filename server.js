const path = require('path');
const os = require('os');
const express = require('express');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();
const rootDir = __dirname;
const port = Number(process.env.PORT) || 3000;
const configuredBaseUrl    = String(process.env.APP_BASE_URL    || '').trim().replace(/\/$/, '');
const configuredFrontendUrl = String(process.env.FRONTEND_URL   || '').trim().replace(/\/$/, '');
const allowedOriginsFromEnv = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

const directPaymentLinks = {
    sbp: process.env.PAYMENT_LINK_SBP || '',
    mir: process.env.PAYMENT_LINK_MIR || '',
    crypto: process.env.PAYMENT_LINK_CRYPTO || '',
    yookassa: process.env.PAYMENT_LINK_YOOKASSA || ''
};

const validMethods = new Set(['sbp', 'mastercard', 'mir', 'crypto', 'yookassa']);
let stripeClient = null;
let smtpTransport = null;
const maxSpeedPayloadBytes = 50 * 1024 * 1024;
const exchangeRateTtlMs = 10 * 60 * 1000;
const defaultUsdRubRate = Number.parseFloat(process.env.DEFAULT_USD_RUB_RATE || '90');
const exchangeRateCache = {
    usdRub: Number.isFinite(defaultUsdRubRate) ? defaultUsdRubRate : 90,
    updatedAt: 0,
    source: 'default'
};
const startupTime = Date.now();
const warmupState = {
    lastRunAt: 0,
    lastDurationMs: 0,
    status: 'idle',
    error: ''
};

app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Статические файлы больше не обслуживаются здесь — фронтенд развёрнут на Render Static Site
// При локальной разработке открывайте index.html напрямую через браузер или Live Server.

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://js.stripe.com'],
            'script-src-attr': ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            fontSrc: ["'self'", 'data:', 'https://cdnjs.cloudflare.com'],
            connectSrc: [
                "'self'",
                'https://speed.cloudflare.com',
                'https://www.google.com',
                'https://postman-echo.com',
                'https://httpbin.org',
                'https://api.stripe.com',
                'https://ipapi.co',
                'https://ipinfo.io'
            ],
            frameSrc: ["'self'", 'https://js.stripe.com', 'https://checkout.stripe.com', 'https://hooks.stripe.com'],
            workerSrc: ["'self'", 'blob:'],
            formAction: ["'self'", 'https://checkout.stripe.com'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

const apiCors = cors(corsOptionsDelegate);
app.use('/api', apiCors);
app.use('/share', apiCors);
app.options('/api/*', apiCors);
app.options('/share', apiCors);

const speedDownloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов скорости. Попробуйте через минуту.' }
});

const speedUploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много upload-запросов. Попробуйте позже.' }
});

const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много попыток платежа. Попробуйте позже.' }
});

const shareLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 80,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов шаринга. Попробуйте позже.' }
});

const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много сообщений. Попробуйте позже.' }
});

app.use('/api/speed-download', speedDownloadLimiter);
app.use('/api/speed-upload', speedUploadLimiter);
app.use('/api/create-payment-session', paymentLimiter);
app.use('/api/contact-developer', contactLimiter);
app.use('/share', shareLimiter);

// Фронтенд раздаётся этим же сервером (same-origin)
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

    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);

    if (configuredBaseUrl) {
        const normalizedBase = normalizeOrigin(configuredBaseUrl);
        if (normalizedBase) origins.add(normalizedBase);
    }

    // Домен фронтенда (отдельный Render Static Site)
    if (configuredFrontendUrl) {
        const normalizedFrontend = normalizeOrigin(configuredFrontendUrl);
        if (normalizedFrontend) origins.add(normalizedFrontend);
    }

    return origins;
}

function corsOptionsDelegate(req, callback) {
    const requestOrigin = normalizeOrigin(req.headers.origin || '');
    const allowedOrigins = getAllowedOrigins();

    if (!requestOrigin) {
        callback(null, { origin: false });
        return;
    }

    if (allowedOrigins.has(requestOrigin)) {
        callback(null, {
            origin: true,
            credentials: false,
            methods: ['GET', 'POST', 'OPTIONS']
        });
        return;
    }

    callback(null, { origin: false });
}

function resolveAppOrigin(req) {
    const headerOrigin = normalizeOrigin(req.headers.origin || '');
    const allowedOrigins = getAllowedOrigins();

    if (headerOrigin && (allowedOrigins.size === 0 || allowedOrigins.has(headerOrigin))) {
        return headerOrigin;
    }

    // Предпочтительно возвращаем URL фронтенда для Stripe redirect
    if (configuredFrontendUrl) {
        return normalizeOrigin(configuredFrontendUrl);
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

function sanitizeText(value, maxLen = 2000) {
    return String(value || '').trim().slice(0, maxLen);
}

function isLikelyGoogleAppPassword(value) {
    return /^[a-zA-Z0-9]{16}$/.test(String(value || '').trim());
}

function classifyContactSendError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '').toLowerCase();
    const responseCode = Number(error?.responseCode || 0);

    if (code === 'EAUTH' || responseCode === 535 || message.includes('invalid login') || message.includes('username and password not accepted')) {
        return 'Ошибка авторизации Gmail: проверьте GMAIL_USER и пароль приложения (GMAIL_APP_PASSWORD).';
    }

    if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || message.includes('querya etimeout')) {
        return 'Сервер не может подключиться к smtp.gmail.com (DNS/сеть). Проверьте интернет, DNS и firewall.';
    }

    return 'Не удалось отправить сообщение';
}

function getSmtpTransport() {
    const gmailUser = String(process.env.GMAIL_USER || '').trim();
    const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD || '').trim();

    if (!gmailUser || !gmailAppPassword) {
        throw new Error('Не настроена почта: задайте GMAIL_USER и GMAIL_APP_PASSWORD');
    }

    if (!isLikelyGoogleAppPassword(gmailAppPassword)) {
        throw new Error('GMAIL_APP_PASSWORD должен быть паролем приложения Google: 16 символов (буквы/цифры, без пробелов и дефисов)');
    }

    if (!smtpTransport) {
        smtpTransport = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            tls: {
                servername: 'smtp.gmail.com'
            },
            auth: {
                user: gmailUser,
                pass: gmailAppPassword
            }
        });
    }

    return smtpTransport;
}

async function fetchUsdRubRateOnline() {
    const endpoints = [
        'https://open.er-api.com/v6/latest/USD',
        'https://api.exchangerate.host/latest?base=USD&symbols=RUB'
    ];

    let lastError = null;

    for (const endpoint of endpoints) {
        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    Accept: 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Exchange endpoint ${endpoint} returned ${response.status}`);
            }

            const data = await response.json();
            const rubRate = Number(data?.rates?.RUB);
            if (!Number.isFinite(rubRate) || rubRate <= 0) {
                throw new Error(`Некорректный курс RUB из ${endpoint}`);
            }

            return {
                usdRub: Number(rubRate.toFixed(4)),
                source: endpoint
            };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Не удалось получить онлайн-курс USD/RUB');
}

function parseCloudflareTrace(rawTrace) {
    const lines = String(rawTrace || '').split('\n');
    const map = {};
    for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) {
            map[key] = value;
        }
    }
    return map;
}

function extractClientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '');
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    const cfIp = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cfIp) return cfIp;

    const realIp = String(req.headers['x-real-ip'] || '').trim();
    if (realIp) return realIp;

    return String(req.socket?.remoteAddress || 'unknown');
}

function isPrivateOrLocalIp(ip) {
    const value = String(ip || '').toLowerCase();
    if (!value || value === 'unknown') return true;
    if (value === '::1' || value === 'localhost') return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:192.168.x.x и т.d.)
    if (value.startsWith('::ffff:')) {
        return isPrivateOrLocalIp(value.slice('::ffff:'.length));
    }
    if (value.startsWith('127.')) return true;
    if (value.startsWith('10.')) return true;
    if (value.startsWith('192.168.')) return true;
    if (/^172\.(2\d|3[0-1])\./.test(value)) return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    if (value.startsWith('fe80:')) return true;
    return false;
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller ? controller.signal : undefined
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function fetchTextWithTimeout(url, timeoutMs = 5000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'text/plain' },
            signal: controller ? controller.signal : undefined
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.text();
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function resolveClientNetworkInfo(ip) {
    if (!ip || isPrivateOrLocalIp(ip)) {
        return { ip: ip || '', isp: null, location: null, country: null, isLocal: true };
    }

    const encodedIp = encodeURIComponent(ip);

    // Провайдер 1: ipapi.co (бесплатно, 1000 зап/день)
    try {
        const d = await fetchJsonWithTimeout(`https://ipapi.co/${encodedIp}/json/`, 5000);
        if (d.error || d.reason) throw new Error(String(d.reason || d.error || 'ipapi.co error'));
        const city    = String(d?.city          || '').trim();
        const region  = String(d?.region        || '').trim();
        const country = String(d?.country_name  || '').trim();
        const isp     = String(d?.org  || d?.asn || '').trim();
        return {
            ip,
            isp:      isp      || null,
            location: [city, region].filter(Boolean).join(', ') || null,
            country:  country  || null
        };
    } catch { /* переходим к следующему */ }

    // Провайдер 2: ip-api.com (HTTP, free — 45 зап/мин)
    try {
        const d = await fetchJsonWithTimeout(
            `http://ip-api.com/json/${encodedIp}?fields=status,message,country,regionName,city,org`,
            5000
        );
        if (d.status !== 'success') throw new Error(d.message || 'ip-api.com failed');
        const city    = String(d?.city       || '').trim();
        const region  = String(d?.regionName || '').trim();
        const isp     = String(d?.org        || '').trim();
        const country = String(d?.country    || '').trim();
        return {
            ip,
            isp:      isp      || null,
            location: [city, region].filter(Boolean).join(', ') || null,
            country:  country  || null
        };
    } catch { /* переходим к следующему */ }

    // Провайдер 3: ipinfo.io (HTTPS, 50k зап/месяц)
    try {
        const d = await fetchJsonWithTimeout(`https://ipinfo.io/${encodedIp}/json`, 5000);
        if (d.bogon || d.error) throw new Error('ipinfo.io error');
        const city    = String(d?.city    || '').trim();
        const region  = String(d?.region  || '').trim();
        const isp     = String(d?.org     || '').trim();
        const country = String(d?.country || '').trim();
        return {
            ip,
            isp:      isp      || null,
            location: [city, region].filter(Boolean).join(', ') || null,
            country:  country  || null
        };
    } catch { /* все провайдеры недоступны */ }

    return { ip, isp: null, location: null, country: null };
}

async function resolveSpeedServerLocation() {
    try {
        const raw = await fetchTextWithTimeout('https://speed.cloudflare.com/cdn-cgi/trace', 5000);
        const parsed = parseCloudflareTrace(raw);
        const loc = String(parsed.loc || '').trim();
        const colo = String(parsed.colo || '').trim();
        return {
            provider: 'Cloudflare Speed Test',
            location: [loc, colo].filter(Boolean).join(' / ') || 'Unknown',
            colo: colo || 'Unknown'
        };
    } catch {
        return {
            provider: 'Cloudflare Speed Test',
            location: 'Unknown',
            colo: 'Unknown'
        };
    }
}

async function runServerWarmup() {
    const started = Date.now();
    warmupState.status = 'running';
    warmupState.error = '';

    try {
        const tasks = await Promise.allSettled([
            fetchUsdRubRateOnline(),
            resolveSpeedServerLocation()
        ]);

        const rateTask = tasks[0];
        if (rateTask.status === 'fulfilled') {
            exchangeRateCache.usdRub = rateTask.value.usdRub;
            exchangeRateCache.updatedAt = Date.now();
            exchangeRateCache.source = rateTask.value.source;
        }

        warmupState.status = 'ok';
    } catch (error) {
        warmupState.status = 'error';
        warmupState.error = String(error?.message || 'warmup failed');
    } finally {
        warmupState.lastRunAt = Date.now();
        warmupState.lastDurationMs = warmupState.lastRunAt - started;
    }
}

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/warmup', async (req, res) => {
    const force = req.query.force === '1';
    const cacheFresh = Date.now() - warmupState.lastRunAt < 5 * 60 * 1000;

    if (force || !cacheFresh) {
        await runServerWarmup();
    }

    return res.json({
        ok: true,
        uptimeSeconds: Math.round(process.uptime()),
        startupAt: startupTime,
        warmup: {
            status: warmupState.status,
            lastRunAt: warmupState.lastRunAt,
            lastDurationMs: warmupState.lastDurationMs,
            error: warmupState.error || null
        },
        server: {
            hostname: os.hostname(),
            region: process.env.RENDER_REGION || process.env.FLY_REGION || 'unknown',
            nodeEnv: process.env.NODE_ENV || 'development'
        }
    });
});

app.get('/api/network-info', async (req, res) => {
    const ip = extractClientIp(req);
    const [client, speedServer] = await Promise.all([
        resolveClientNetworkInfo(ip),
        resolveSpeedServerLocation()
    ]);

    return res.json({
        ok: true,
        client,
        speedServer,
        appServer: {
            region: process.env.RENDER_REGION || process.env.FLY_REGION || 'unknown',
            hostname: os.hostname()
        }
    });
});

app.get('/api/exchange-rate', async (req, res) => {
    const forceRefresh = req.query.force === '1';
    const now = Date.now();
    const cacheIsFresh = now - exchangeRateCache.updatedAt < exchangeRateTtlMs;

    if (!forceRefresh && cacheIsFresh) {
        return res.json({
            ok: true,
            base: 'USD',
            quote: 'RUB',
            rate: exchangeRateCache.usdRub,
            updatedAt: exchangeRateCache.updatedAt,
            source: exchangeRateCache.source,
            cached: true
        });
    }

    try {
        const online = await fetchUsdRubRateOnline();
        exchangeRateCache.usdRub = online.usdRub;
        exchangeRateCache.updatedAt = now;
        exchangeRateCache.source = online.source;

        return res.json({
            ok: true,
            base: 'USD',
            quote: 'RUB',
            rate: exchangeRateCache.usdRub,
            updatedAt: exchangeRateCache.updatedAt,
            source: exchangeRateCache.source,
            cached: false
        });
    } catch (error) {
        return res.status(200).json({
            ok: true,
            base: 'USD',
            quote: 'RUB',
            rate: exchangeRateCache.usdRub,
            updatedAt: exchangeRateCache.updatedAt,
            source: exchangeRateCache.source,
            cached: true,
            fallback: true,
            warning: error.message || 'Онлайн-курс временно недоступен'
        });
    }
});

app.get('/api/speed-download', (req, res) => {
    const requested = Number.parseInt(String(req.query.bytes || ''), 10);
    const bytes = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, maxSpeedPayloadBytes)
        : 5 * 1024 * 1024;

    const chunkSize = 64 * 1024;
    const chunk = Buffer.alloc(chunkSize, 97);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    let sent = 0;

    const writeNext = () => {
        while (sent < bytes) {
            const remaining = bytes - sent;
            const currentChunkSize = Math.min(chunkSize, remaining);
            const ok = res.write(chunk.subarray(0, currentChunkSize));
            sent += currentChunkSize;
            if (!ok) {
                res.once('drain', writeNext);
                return;
            }
        }

        res.end();
    };

    writeNext();
});

app.post('/api/speed-upload', express.raw({ type: '*/*', limit: '60mb' }), (req, res) => {
    const size = req.body && Buffer.isBuffer(req.body) ? req.body.length : 0;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.status(200).json({ ok: true, bytesReceived: size });
});

app.post('/api/create-payment-session', async (req, res) => {
    try {
        const { amount, currency, method } = assertPaymentPayload(req.body);
        const isStripeMethod = method === 'mastercard';

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
    const text  = String(req.body.text  || '');
    const url   = String(req.body.url   || '');
    const params = new URLSearchParams({ shared: '1', title, text, url });
    // Перенаправляем на фронтенд (Render Static Site)
    const frontendBase = configuredFrontendUrl || configuredBaseUrl || `http://localhost:${port}`;
    res.redirect(`${frontendBase}/index.html?${params.toString()}`);
});

app.post('/api/contact-developer', async (req, res) => {
    try {
        const name = sanitizeText(req.body?.name, 120);
        const senderEmail = sanitizeText(req.body?.email, 180);
        const message = sanitizeText(req.body?.message, 4000);

        if (!message || message.length < 5) {
            return res.status(400).json({ error: 'Введите сообщение (минимум 5 символов)' });
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (senderEmail && !emailPattern.test(senderEmail)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }

        const toEmail = String(process.env.DEVELOPER_EMAIL_TO || process.env.GMAIL_USER || '').trim();
        if (!toEmail) {
            throw new Error('Не настроен DEVELOPER_EMAIL_TO или GMAIL_USER');
        }

        const transport = getSmtpTransport();
        const fromEmail = String(process.env.GMAIL_USER || '').trim();

        const subject = `SpeedDash Pro: сообщение разработчику${name ? ` от ${name}` : ''}`;
        const textBody = [
            'Новое сообщение с сайта SpeedDash Pro',
            '',
            `Имя: ${name || 'Не указано'}`,
            `Email: ${senderEmail || 'Не указан'}`,
            '',
            'Сообщение:',
            message
        ].join('\n');

        await transport.sendMail({
            from: fromEmail,
            to: toEmail,
            replyTo: senderEmail || undefined,
            subject,
            text: textBody
        });

        return res.json({ ok: true });
    } catch (error) {
        console.error('contact-developer error:', error);
        return res.status(500).json({ error: classifyContactSendError(error) });
    }
});

// catch-all удалён: фронтенд обслуживается Render Static Site

app.get('*', (_req, res) => {
    res.sendFile(path.join(rootDir, 'index.html'));
});

app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Слишком большой payload' });
    }

    if (err) {
        return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    return next();
});

// Keep-alive: пингуем себя каждые 14 минут, чтобы Render не усыплял (free tier спит после 15 мин без запросов)
const keepAliveIntervalMs = 14 * 60 * 1000;

function startKeepAlive() {
    const selfBase = configuredBaseUrl || `http://localhost:${port}`;
    const pingUrl = `${selfBase}/health`;

    setInterval(async () => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const response = await fetch(pingUrl, {
                method: 'GET',
                headers: { 'User-Agent': 'SpeedDash-KeepAlive/1.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (!response.ok) {
                console.warn(`[keep-alive] /health вернул ${response.status}`);
            }
        } catch (error) {
            console.warn('[keep-alive] self-ping не удался:', error?.message || error);
        }
    }, keepAliveIntervalMs);

    console.log(`[keep-alive] запущен, пинг каждые ${keepAliveIntervalMs / 60000} мин → ${pingUrl}`);
}

app.listen(port, () => {
    console.log(`SpeedDash Pro web server listening on http://localhost:${port}`);

    runServerWarmup().catch((error) => {
        console.error('Initial warmup error:', error?.message || error);
    });

    // Запускаем keep-alive только в production и только если настроен APP_BASE_URL
    if (configuredBaseUrl && process.env.NODE_ENV !== 'development') {
        startKeepAlive();
    }
});
