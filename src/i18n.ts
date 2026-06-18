export const SUPPORTED_LOCALES = [
    'en',
    'ar',
    'de',
    'es',
    'fr',
    'hi',
    'id',
    'it',
    'ja',
    'ko',
    'pt-br',
    'ru',
    'tr',
    'vi',
    'zh-cn',
    'zh-tw',
] as const;

export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

type TranslationKey =
    'action.openSettings' |
    'alert.dailyCostExceeded' |
    'message.summaryCopied';

type TranslationMessages = Record<TranslationKey, string>;

const MESSAGES: Record<SupportedLocale, TranslationMessages> = {
    en: {
        'action.openSettings': 'Open Settings',
        'alert.dailyCostExceeded': "otak-usage daily cost alert: today's total is {total}, above your daily alert threshold of {threshold}.",
        'message.summaryCopied': 'otak-usage: summary copied to clipboard',
    },
    ar: {
        'action.openSettings': 'فتح الإعدادات',
        'alert.dailyCostExceeded': 'تنبيه تكلفة otak-usage اليومية: إجمالي اليوم هو {total}، وقد تجاوز حد التنبيه اليومي {threshold}.',
        'message.summaryCopied': 'otak-usage: تم نسخ الملخص إلى الحافظة',
    },
    de: {
        'action.openSettings': 'Einstellungen öffnen',
        'alert.dailyCostExceeded': 'otak-usage Tageskostenalarm: Die heutige Summe beträgt {total} und liegt über dem täglichen Grenzwert von {threshold}.',
        'message.summaryCopied': 'otak-usage: Zusammenfassung in die Zwischenablage kopiert',
    },
    es: {
        'action.openSettings': 'Abrir configuración',
        'alert.dailyCostExceeded': 'Alerta de coste diario de otak-usage: el total de hoy es {total}, por encima del umbral diario de {threshold}.',
        'message.summaryCopied': 'otak-usage: resumen copiado al portapapeles',
    },
    fr: {
        'action.openSettings': 'Ouvrir les paramètres',
        'alert.dailyCostExceeded': "Alerte de coût quotidien otak-usage : le total d'aujourd'hui est de {total}, au-dessus du seuil quotidien de {threshold}.",
        'message.summaryCopied': 'otak-usage : résumé copié dans le presse-papiers',
    },
    hi: {
        'action.openSettings': 'सेटिंग खोलें',
        'alert.dailyCostExceeded': 'otak-usage दैनिक लागत अलर्ट: आज का कुल {total} है, जो आपके दैनिक अलर्ट सीमा {threshold} से अधिक है।',
        'message.summaryCopied': 'otak-usage: सारांश क्लिपबोर्ड पर कॉपी किया गया',
    },
    id: {
        'action.openSettings': 'Buka Pengaturan',
        'alert.dailyCostExceeded': 'Peringatan biaya harian otak-usage: total hari ini {total}, melebihi ambang peringatan harian {threshold}.',
        'message.summaryCopied': 'otak-usage: ringkasan disalin ke clipboard',
    },
    it: {
        'action.openSettings': 'Apri impostazioni',
        'alert.dailyCostExceeded': 'Avviso costo giornaliero di otak-usage: il totale di oggi è {total}, sopra la soglia giornaliera di {threshold}.',
        'message.summaryCopied': 'otak-usage: riepilogo copiato negli appunti',
    },
    ja: {
        'action.openSettings': '設定を開く',
        'alert.dailyCostExceeded': 'otak-usage の本日合計が {total} になり、1日あたりのアラートしきい値 {threshold} を超えました。',
        'message.summaryCopied': 'otak-usage: サマリーをクリップボードにコピーしました',
    },
    ko: {
        'action.openSettings': '설정 열기',
        'alert.dailyCostExceeded': 'otak-usage 일일 비용 알림: 오늘 합계가 {total}이며 일일 알림 기준 {threshold}를 초과했습니다.',
        'message.summaryCopied': 'otak-usage: 요약을 클립보드에 복사했습니다',
    },
    'pt-br': {
        'action.openSettings': 'Abrir configurações',
        'alert.dailyCostExceeded': 'Alerta de custo diário do otak-usage: o total de hoje é {total}, acima do limite diário de {threshold}.',
        'message.summaryCopied': 'otak-usage: resumo copiado para a área de transferência',
    },
    ru: {
        'action.openSettings': 'Открыть настройки',
        'alert.dailyCostExceeded': 'Ежедневное предупреждение otak-usage: сумма за сегодня {total}, что выше дневного порога {threshold}.',
        'message.summaryCopied': 'otak-usage: сводка скопирована в буфер обмена',
    },
    tr: {
        'action.openSettings': 'Ayarları Aç',
        'alert.dailyCostExceeded': 'otak-usage günlük maliyet uyarısı: bugünün toplamı {total}; günlük uyarı eşiği {threshold} üzerinde.',
        'message.summaryCopied': 'otak-usage: özet panoya kopyalandı',
    },
    vi: {
        'action.openSettings': 'Mở cài đặt',
        'alert.dailyCostExceeded': 'Cảnh báo chi phí hằng ngày của otak-usage: tổng hôm nay là {total}, vượt ngưỡng cảnh báo hằng ngày {threshold}.',
        'message.summaryCopied': 'otak-usage: đã sao chép tóm tắt vào clipboard',
    },
    'zh-cn': {
        'action.openSettings': '打开设置',
        'alert.dailyCostExceeded': 'otak-usage 每日费用提醒：今天合计为 {total}，已超过每日提醒阈值 {threshold}。',
        'message.summaryCopied': 'otak-usage：摘要已复制到剪贴板',
    },
    'zh-tw': {
        'action.openSettings': '開啟設定',
        'alert.dailyCostExceeded': 'otak-usage 每日費用提醒：今天合計為 {total}，已超過每日提醒門檻 {threshold}。',
        'message.summaryCopied': 'otak-usage：摘要已複製到剪貼簿',
    },
};

export class I18n {
    private readonly locale: SupportedLocale;

    constructor(locale: string | undefined) {
        this.locale = resolveSupportedLocale(locale);
    }

    public t(key: TranslationKey, params?: Record<string, string>): string {
        const template = MESSAGES[this.locale][key] ?? MESSAGES.en[key];
        if (!params) {
            return template;
        }
        let result = template;
        for (const [name, value] of Object.entries(params)) {
            result = result.replace(new RegExp(`\\{${escapeRegExp(name)}\\}`, 'g'), value);
        }
        return result;
    }

    public getCurrentLocale(): SupportedLocale {
        return this.locale;
    }
}

export function resolveSupportedLocale(locale: string | undefined): SupportedLocale {
    const normalized = (locale ?? '').trim().replace(/_/g, '-').toLowerCase();
    if (isSupportedLocale(normalized)) {
        return normalized;
    }

    const base = normalized.split('-')[0];
    if (base === 'zh') {
        return normalized.includes('hant') || normalized.includes('tw') || normalized.includes('hk') || normalized.includes('mo')
            ? 'zh-tw'
            : 'zh-cn';
    }
    if (base === 'pt') {
        return 'pt-br';
    }
    if (isSupportedLocale(base)) {
        return base;
    }
    return 'en';
}

function isSupportedLocale(locale: string): locale is SupportedLocale {
    return SUPPORTED_LOCALES.includes(locale as SupportedLocale);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
