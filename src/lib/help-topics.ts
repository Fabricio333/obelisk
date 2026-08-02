import type { Locale } from '@/i18n';

/**
 * The four entry-point help topics, shared by the `/help` page and the
 * help popover in the chat top bar. One source so the two surfaces can't
 * drift — the popover exists precisely so the user doesn't have to leave
 * the chat to reach these.
 */
export interface HelpTopic {
  /** Guide slug — resolved through `guidesHref(locale, slug)`. */
  readonly slug: string;
  readonly title: string;
  readonly description: string;
}

export const HELP_TOPICS: Record<Locale, ReadonlyArray<HelpTopic>> = {
  en: [
    {
      slug: 'what-is-obelisk',
      title: 'Getting started',
      description: 'Learn what Obelisk is and how your Nostr identity works.',
    },
    {
      slug: 'how-obelisk-works',
      title: 'How Obelisk works',
      description: 'Understand groups, relays, messages, and privacy.',
    },
    {
      slug: 'admin-cli',
      title: 'Run a community',
      description: 'Create and manage a group from the admin CLI.',
    },
    {
      slug: 'bitcoin-zaps',
      title: 'Payments and zaps',
      description: 'Send Lightning payments without leaving the conversation.',
    },
  ],
  es: [
    {
      slug: 'what-is-obelisk',
      title: 'Primeros pasos',
      description: 'Conocé qué es Obelisk y cómo funciona tu identidad Nostr.',
    },
    {
      slug: 'how-obelisk-works',
      title: 'Cómo funciona Obelisk',
      description: 'Entendé los grupos, relays, mensajes y privacidad.',
    },
    {
      slug: 'admin-cli',
      title: 'Administrar una comunidad',
      description: 'Creá y administrá un grupo desde la CLI.',
    },
    {
      slug: 'bitcoin-zaps',
      title: 'Pagos y zaps',
      description: 'Enviá pagos Lightning sin salir de la conversación.',
    },
  ],
};

/** Label for the "see everything" affordance on both surfaces. */
export const HELP_VIEW_MORE: Record<Locale, string> = {
  en: 'View more guides',
  es: 'Ver más guías',
};
