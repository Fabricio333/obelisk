import { describe, it, expect } from 'vitest';
import {
  getTranslation,
  countryToLocale,
  acceptLanguageToLocale,
  detectLocale,
  LATAM_COUNTRIES,
  DEFAULT_LOCALE,
  type Locale,
} from '../index';

describe('getTranslation', () => {
  it('returns English strings for "en" locale', () => {
    const t = getTranslation('en');
    expect(t('hero.title')).toBe('Tus comunidades,');
    expect(t('hero.titleHighlight')).toBe('bajo tu control');
  });

  it('returns Spanish strings for "es" locale', () => {
    const t = getTranslation('es');
    expect(t('hero.title')).toBe('Tus comunidades,');
    expect(t('hero.titleHighlight')).toBe('bajo tu control');
  });

  it('returns the key itself for missing translations', () => {
    const t = getTranslation('en');
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('defaults to Spanish for unknown locale', () => {
    const t = getTranslation('fr' as unknown as Locale);
    expect(t('hero.title')).toBe('Tus comunidades,');
  });

  it('identifies Obelisk as the operator of its public relays', () => {
    expect(getTranslation('en')('faq.q2.answer')).toContain('Obelisk operates two public relays');
    expect(getTranslation('es')('faq.q2.answer')).toContain('Obelisk opera dos relays públicos');
  });
});

describe('countryToLocale', () => {
  it('returns "es" for LATAM countries', () => {
    expect(countryToLocale('AR')).toBe('es');
    expect(countryToLocale('MX')).toBe('es');
    expect(countryToLocale('CO')).toBe('es');
    expect(countryToLocale('ES')).toBe('es');
  });

  it('returns "en" for non-LATAM countries', () => {
    expect(countryToLocale('US')).toBe('en');
    expect(countryToLocale('GB')).toBe('en');
    expect(countryToLocale('DE')).toBe('en');
  });

  it('handles lowercase country codes', () => {
    expect(countryToLocale('ar')).toBe('es');
    expect(countryToLocale('us')).toBe('en');
  });

  it('returns default locale (es) when country is null', () => {
    expect(countryToLocale(null)).toBe('es');
  });

  it('default locale is "es"', () => {
    expect(DEFAULT_LOCALE).toBe('es');
  });

  it('LATAM_COUNTRIES includes key countries', () => {
    expect(LATAM_COUNTRIES.has('AR')).toBe(true);
    expect(LATAM_COUNTRIES.has('MX')).toBe(true);
    expect(LATAM_COUNTRIES.has('CL')).toBe(true);
    expect(LATAM_COUNTRIES.has('US')).toBe(false);
  });
});


describe('acceptLanguageToLocale', () => {
  it('uses the highest-priority supported language', () => {
    expect(acceptLanguageToLocale('en-US,en;q=0.8,es;q=0.7')).toBe('en');
    expect(acceptLanguageToLocale('fr-FR,es-AR;q=0.9,en;q=0.4')).toBe('es');
  });

  it('returns null when no supported language is present', () => {
    expect(acceptLanguageToLocale('fr-FR,pt-BR;q=0.9')).toBeNull();
    expect(acceptLanguageToLocale(null)).toBeNull();
  });
});

describe('detectLocale', () => {
  it('keeps an explicit cookie locale ahead of geo and browser hints', () => {
    expect(detectLocale({ cookieLocale: 'es', countryCode: 'US', acceptLanguage: 'en-US' })).toBe('es');
    expect(detectLocale({ cookieLocale: 'en', countryCode: 'AR', acceptLanguage: 'es-AR' })).toBe('en');
  });

  it('uses country before Accept-Language when there is no cookie', () => {
    expect(detectLocale({ countryCode: 'AR', acceptLanguage: 'en-US' })).toBe('es');
    expect(detectLocale({ countryCode: 'US', acceptLanguage: 'es-AR' })).toBe('en');
  });

  it('falls back to Accept-Language and then the default locale', () => {
    expect(detectLocale({ acceptLanguage: 'es-AR,es;q=0.9' })).toBe('es');
    expect(detectLocale({ acceptLanguage: 'fr-FR' })).toBe(DEFAULT_LOCALE);
  });
});
