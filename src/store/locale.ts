import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { quotaSafeLocalStorage } from '@/lib/quota-safe-storage';
import { defaultLocale, t, type Locale } from '@/lib/i18n';

interface LocaleState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: defaultLocale,
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: 'obelisk:locale',
      storage: createJSONStorage(() => quotaSafeLocalStorage),
    }
  )
);

export function useT() {
  const locale = useLocaleStore((s) => s.locale);
  return (key: string) => t(key, locale);
}
