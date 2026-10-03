// Live mode, phase L2: known packages → what they are for, so "npm install
// next-auth" reads "Adding an authentication library". A package that is not
// here reads "Installing a dependency: <name>" (never guessed).
const PURPOSES = {
  authentication: ['next-auth', '@auth/core', '@auth/prisma-adapter', '@auth/drizzle-adapter', 'passport', 'passport-local', 'passport-google-oauth20', 'passport-jwt',
    '@clerk/nextjs', '@clerk/clerk-react', 'lucia', 'better-auth', 'jsonwebtoken', 'jose', 'bcrypt', 'bcryptjs', 'argon2', '@supabase/auth-helpers-nextjs',
    'firebase-auth', '@kinde-oss/kinde-auth-nextjs', 'express-session', 'iron-session', 'django-allauth', 'authlib', 'python-jose', 'passlib', 'flask-login', 'pyjwt'],
  database: ['prisma', '@prisma/client', 'drizzle-orm', 'drizzle-kit', 'pg', 'postgres', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'better-sqlite3', 'sqlite3',
    'knex', 'sequelize', 'typeorm', 'kysely', '@supabase/supabase-js', '@supabase/ssr', '@neondatabase/serverless', '@vercel/postgres', '@libsql/client',
    'ioredis', 'redis', 'firebase-admin', 'sqlalchemy', 'psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'pymongo', 'alembic', 'sqlmodel', 'peewee', 'tortoise-orm'],
  payments: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js', '@paypal/react-paypal-js', '@lemonsqueezy/lemonsqueezy.js', 'paddle-sdk'],
  email: ['resend', 'nodemailer', '@sendgrid/mail', 'postmark', 'mailgun.js', '@react-email/components', 'react-email', 'sendgrid'],
  'artificial intelligence': ['openai', '@anthropic-ai/sdk', 'anthropic', '@google/generative-ai', '@google/genai', '@mistralai/mistralai', 'ai', '@ai-sdk/openai',
    '@ai-sdk/anthropic', 'groq-sdk', 'langchain', '@langchain/core', 'ollama', 'transformers', 'google-generativeai'],
  'file storage': ['@aws-sdk/client-s3', '@vercel/blob', 'cloudinary', 'multer', 'uploadthing', 'boto3', '@supabase/storage-js', 'formidable'],
  'user interface': ['react', 'react-dom', 'next', 'vue', 'svelte', '@radix-ui/react-dialog', '@radix-ui/react-slot', '@headlessui/react', '@mui/material',
    '@chakra-ui/react', 'antd', 'shadcn', 'shadcn-ui', 'class-variance-authority', 'vaul', 'sonner', 'react-hot-toast', 'cmdk', '@tanstack/react-table'],
  styling: ['tailwindcss', '@tailwindcss/postcss', 'postcss', 'autoprefixer', 'sass', 'styled-components', '@emotion/react', 'clsx', 'tailwind-merge', 'tailwindcss-animate'],
  icons: ['lucide-react', 'react-icons', '@heroicons/react', '@tabler/icons-react'],
  animation: ['framer-motion', 'motion', 'gsap', 'react-spring'],
  forms: ['react-hook-form', '@hookform/resolvers', 'formik'],
  'data validation': ['zod', 'yup', 'joi', 'valibot', 'class-validator', 'pydantic'],
  testing: ['jest', 'vitest', '@testing-library/react', '@testing-library/jest-dom', '@playwright/test', 'playwright', 'cypress', 'mocha', 'chai', 'supertest',
    'pytest', 'pytest-asyncio', 'msw'],
  'web requests': ['axios', 'node-fetch', 'ky', 'got', 'swr', '@tanstack/react-query', 'requests', 'httpx', 'aiohttp'],
  'app state': ['zustand', 'redux', '@reduxjs/toolkit', 'jotai', 'recoil', 'mobx', 'pinia'],
  dates: ['date-fns', 'dayjs', 'moment', 'luxon'],
  charts: ['recharts', 'chart.js', 'react-chartjs-2', 'd3', '@nivo/core', 'apexcharts', 'echarts'],
  translation: ['next-intl', 'i18next', 'react-i18next', 'next-i18next', 'vue-i18n'],
  logging: ['winston', 'pino', 'morgan', 'loguru'],
  'real-time': ['socket.io', 'socket.io-client', 'ws', 'pusher', 'pusher-js', 'ably', '@liveblocks/client'],
  maps: ['leaflet', 'react-leaflet', 'mapbox-gl', '@react-google-maps/api'],
  analytics: ['posthog-js', 'posthog-node', '@vercel/analytics', 'mixpanel', '@sentry/nextjs', '@sentry/node', '@sentry/react'],
  'text formatting': ['react-markdown', 'marked', 'remark', 'rehype', 'markdown-it', 'dompurify', 'sanitize-html'],
  security: ['helmet', 'cors', 'express-rate-limit', 'csurf', '@upstash/ratelimit'],
  server: ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'flask', 'fastapi', 'django', 'uvicorn', 'gunicorn', 'starlette'],
  'development tools': ['typescript', 'eslint', 'prettier', 'nodemon', 'ts-node', 'tsx', 'vite', 'webpack', 'esbuild', 'concurrently', 'dotenv', 'cross-env',
    'eslint-config-next', 'husky', 'lint-staged', 'black', 'ruff', 'mypy'],
};

const BY_NAME = new Map(Object.entries(PURPOSES).flatMap(([purpose, names]) => names.map(name => [name, purpose])));

// "next-auth@5.0.0" → "next-auth"; "@auth/core@beta" → "@auth/core"; "django>=5" → "django".
export function packageName(spec) {
  const text = String(spec).trim();
  if (text.startsWith('@')) return text.split('@').slice(0, 2).join('@');
  return text.split(/[@=<>~!\[]/)[0];
}

// What a package is for, or null.
export function packagePurpose(spec) {
  const name = packageName(spec).toLowerCase();
  if (name.startsWith('@types/')) return 'type definitions';
  if (BY_NAME.has(name)) return BY_NAME.get(name);
  // A scope known as a whole (@radix-ui/react-tabs, @aws-sdk/client-ses, @tiptap/react…).
  for (const [scope, purpose] of [['@radix-ui/', 'user interface'], ['@aws-sdk/', 'cloud services'], ['@supabase/', 'database'], ['@clerk/', 'authentication'],
    ['@auth/', 'authentication'], ['@prisma/', 'database'], ['@sentry/', 'analytics'], ['@testing-library/', 'testing'], ['@tiptap/', 'text editor'],
    ['@stripe/', 'payments'], ['@ai-sdk/', 'artificial intelligence'], ['@langchain/', 'artificial intelligence'], ['@tanstack/', 'app state']]) {
    if (name.startsWith(scope)) return purpose;
  }
  return null;
}

export const PACKAGE_COUNT = BY_NAME.size;
