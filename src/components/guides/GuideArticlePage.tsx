import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import type { Locale } from '@/i18n';
import {
  readGuide,
  estimateReadMinutes,
  type GuideFrontmatter,
} from '@/lib/guides';
import { guidesHref } from '@/lib/guide-urls';
import ArticleShell from '@/components/guides/ArticleShell';
import GuideLocaleSync from '@/components/guides/GuideLocaleSync';
import { mdxComponents } from '@/components/guides/mdx-components';
import RelatedGuides from '@/components/guides/RelatedGuides';
import {
  HERO_ASSET_META,
  DIAGRAM_ASSET_META,
  snapshotPaths,
  type GuideAssetMeta,
} from '@/components/guides/svg/asset-meta';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';

const ASSET_REF_RE = /<(?:Diagram|SvgHero)\s+[^>]*name=["']([^"']+)["']/g;

function collectGuideImages(
  heroName: string | undefined,
  content: string,
  siteUrl: string,
): Array<{ url: string; meta: GuideAssetMeta }> {
  const names = new Set<string>();
  if (heroName) names.add(heroName);
  for (const m of content.matchAll(ASSET_REF_RE)) names.add(m[1]);
  const out: Array<{ url: string; meta: GuideAssetMeta }> = [];
  for (const n of names) {
    const meta = HERO_ASSET_META[n] ?? DIAGRAM_ASSET_META[n];
    if (!meta) continue;
    out.push({ url: `${siteUrl}${snapshotPaths(n).png}`, meta });
  }
  return out;
}

const SITE_URL = process.env.CORS_ORIGIN || 'https://obelisk.ar';

const CHROME: Record<Locale, Record<string, string>> = {
  en: {
    back: 'All guides',
    readTime: 'min read',
    updated: 'Updated',
  },
  es: {
    back: 'Todas las guías',
    readTime: 'min de lectura',
    updated: 'Actualizado',
  },
};

async function safeRead(locale: Locale, slug: string) {
  try {
    return await readGuide(locale, slug);
  } catch {
    return null;
  }
}

export async function buildGuideArticleMetadata(
  locale: Locale,
  slug: string,
): Promise<Metadata> {
  const guide = await safeRead(locale, slug);
  if (!guide) return {};

  const fm = guide.frontmatter as GuideFrontmatter;
  const canonical = guidesHref(locale, slug);
  const heroMeta = HERO_ASSET_META[fm.heroComponent];
  const heroUrl = heroMeta
    ? `${SITE_URL}${snapshotPaths(fm.heroComponent).png}`
    : `${SITE_URL}${canonical}/opengraph-image`;
  const heroWidth = heroMeta ? heroMeta.width * 2 : 1200;
  const heroHeight = heroMeta ? heroMeta.height * 2 : 630;
  const heroAlt = heroMeta?.alt ?? fm.title;

  return {
    title: fm.title,
    description: fm.description,
    alternates: {
      canonical,
      languages: {
        'en-US': guidesHref('en', slug),
        'es-AR': guidesHref('es', slug),
        'x-default': guidesHref('en', slug),
      },
    },
    openGraph: {
      title: fm.title,
      description: fm.description,
      url: `${SITE_URL}${canonical}`,
      siteName: 'Obelisk',
      locale: locale === 'en' ? 'en_US' : 'es_AR',
      alternateLocale: locale === 'en' ? ['es_AR'] : ['en_US'],
      type: 'article',
      publishedTime: fm.publishedAt,
      modifiedTime: fm.updatedAt,
      tags: fm.tags,
      images: [
        {
          url: heroUrl,
          width: heroWidth,
          height: heroHeight,
          alt: heroAlt,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: fm.title,
      description: fm.description,
      images: [heroUrl],
    },
    keywords: fm.tags,
  };
}

export default async function GuideArticlePage({
  locale,
  slug,
}: {
  locale: Locale;
  slug: string;
}) {
  const guide = await safeRead(locale, slug);
  if (!guide) notFound();

  const fm = guide.frontmatter as GuideFrontmatter;
  const chrome = CHROME[locale];
  const readMinutes = fm.readMinutes ?? estimateReadMinutes(guide.content);
  const canonical = guidesHref(locale, slug);

  const guideImages = collectGuideImages(fm.heroComponent, guide.content, SITE_URL);
  const heroMeta = HERO_ASSET_META[fm.heroComponent];
  const heroUrl = heroMeta
    ? `${SITE_URL}${snapshotPaths(fm.heroComponent).png}`
    : `${SITE_URL}${canonical}/opengraph-image`;
  const heroWidth = heroMeta ? heroMeta.width * 2 : 1200;
  const heroHeight = heroMeta ? heroMeta.height * 2 : 630;
  const heroAlt = heroMeta?.alt ?? fm.title;

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: fm.title,
    description: fm.description,
    datePublished: fm.publishedAt,
    dateModified: fm.updatedAt,
    inLanguage: locale === 'en' ? 'en' : 'es-AR',
    image: [
      {
        '@type': 'ImageObject',
        url: heroUrl,
        width: heroWidth,
        height: heroHeight,
        caption: heroAlt,
      },
      ...guideImages
        .filter((img) => img.url !== heroUrl)
        .map((img) => ({
          '@type': 'ImageObject',
          url: img.url,
          width: img.meta.width * 2,
          height: img.meta.height * 2,
          caption: img.meta.alt,
        })),
    ],
    author: {
      '@type': 'Organization',
      name: 'La Crypta',
      url: 'https://lacrypta.ar',
    },
    publisher: {
      '@type': 'Organization',
      name: 'La Crypta',
      logo: {
        '@type': 'ImageObject',
        url: `${SITE_URL}/icon-512.png`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${SITE_URL}${canonical}`,
    },
    keywords: fm.tags?.join(', '),
  };

  return (
    <div className="min-h-screen bg-lc-black lc-grid-bg">
      <GuideLocaleSync locale={locale} />
      <Navbar />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <ArticleShell
        frontmatter={fm}
        locale={locale}
        slug={slug}
        readMinutes={readMinutes}
        backHref={guidesHref(locale)}
        backLabel={chrome.back}
        readTimeLabel={chrome.readTime}
        updatedLabel={chrome.updated}
      >
        <MDXRemote
          source={guide.content}
          components={{
            ...mdxComponents,
            RelatedGuides: (props: { items: Array<{ slug: string; note?: string }> }) => (
              <RelatedGuides locale={locale} {...props} />
            ),
          }}
          options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
        />
      </ArticleShell>
      <Footer localeOverride={locale} />
    </div>
  );
}
