export function installerLanguage(requested = 'auto', timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!['auto', 'zh', 'en'].includes(requested)) throw new Error('--lang must be auto, zh or en / --lang 必须为 auto、zh 或 en');
  if (requested !== 'auto') return requested;
  return /^(?:Asia\/(?:Shanghai|Chongqing|Chungking|Harbin|Urumqi|Kashgar|Hong_Kong|Macao|Macau|Taipei)|PRC|ROC|Hongkong|China Standard Time|Taipei Standard Time)$/i.test(timeZone ?? '') ? 'zh' : 'en';
}
