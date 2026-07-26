'use client';

import Link from 'next/link';
import Footer from '@/components/Footer';
import Navbar from '@/components/Navbar';
import { guidesHref } from '@/lib/guide-urls';
import { useTranslation } from '@/i18n/context';

const COPY = {
  en: {
    title: 'How can we help?',
    subtitle: 'Start with the basics or jump straight to the topic you need.',
    back: '← Back to Obelisk',
    all: 'Browse all guides →',
    topics: [
      ['Getting started', 'Learn what Obelisk is and how your Nostr identity works.', 'what-is-obelisk'],
      ['How Obelisk works', 'Understand groups, relays, messages, and privacy.', 'how-obelisk-works'],
      ['Run a community', 'Create and manage a group from the admin CLI.', 'admin-cli'],
      ['Payments and zaps', 'Send Lightning payments without leaving the conversation.', 'bitcoin-zaps'],
    ],
  },
  es: {
    title: '¿Cómo podemos ayudarte?',
    subtitle: 'Empezá por lo básico o andá directo al tema que necesitás.',
    back: '← Volver a Obelisk',
    all: 'Ver todas las guías →',
    topics: [
      ['Primeros pasos', 'Conocé qué es Obelisk y cómo funciona tu identidad Nostr.', 'what-is-obelisk'],
      ['Cómo funciona Obelisk', 'Entendé los grupos, relays, mensajes y privacidad.', 'how-obelisk-works'],
      ['Administrar una comunidad', 'Creá y administrá un grupo desde la CLI.', 'admin-cli'],
      ['Pagos y zaps', 'Enviá pagos Lightning sin salir de la conversación.', 'bitcoin-zaps'],
    ],
  },
} as const;

export default function HelpPage() {
  const { locale } = useTranslation();
  const copy = COPY[locale];

  return (
    <div className="min-h-screen bg-lc-black lc-grid-bg">
      <Navbar />
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-28">
        <Link href="/app" className="text-sm font-medium text-lc-green hover:text-lc-green-dark">
          {copy.back}
        </Link>
        <h1 className="mt-5 text-4xl font-extrabold tracking-tight text-lc-white md:text-5xl">
          {copy.title}
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-lc-muted">{copy.subtitle}</p>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {copy.topics.map(([title, description, slug]) => (
            <Link
              key={slug}
              href={guidesHref(locale, slug)}
              data-testid={`help-topic-${slug}`}
              className="lc-card group p-6 transition-colors hover:border-lc-green/50"
            >
              <h2 className="text-lg font-bold text-lc-white group-hover:text-lc-green">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-lc-muted">{description}</p>
            </Link>
          ))}
        </div>

        <Link
          href={guidesHref(locale)}
          className="lc-pill-primary mt-8 inline-flex px-6 py-3 text-sm font-semibold"
        >
          {copy.all}
        </Link>
      </main>
      <Footer localeOverride={locale} />
    </div>
  );
}
