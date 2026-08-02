'use client';

import Link from 'next/link';
import Footer from '@/components/Footer';
import Navbar from '@/components/Navbar';
import { guidesHref } from '@/lib/guide-urls';
import { HELP_TOPICS } from '@/lib/help-topics';
import { useTranslation } from '@/i18n/context';

const COPY = {
  en: {
    title: 'How can we help?',
    subtitle: 'Start with the basics or jump straight to the topic you need.',
    back: '← Back to Obelisk',
    all: 'Browse all guides →',
  },
  es: {
    title: '¿Cómo podemos ayudarte?',
    subtitle: 'Empezá por lo básico o andá directo al tema que necesitás.',
    back: '← Volver a Obelisk',
    all: 'Ver todas las guías →',
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
          {HELP_TOPICS[locale].map((topic) => (
            <Link
              key={topic.slug}
              href={guidesHref(locale, topic.slug)}
              data-testid={`help-topic-${topic.slug}`}
              className="lc-card group p-6 transition-colors hover:border-lc-green/50"
            >
              <h2 className="text-lg font-bold text-lc-white group-hover:text-lc-green">{topic.title}</h2>
              <p className="mt-2 text-sm leading-6 text-lc-muted">{topic.description}</p>
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
