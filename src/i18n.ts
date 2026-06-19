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
    'message.summaryCopied' |
    'tooltip.allTime' |
    'tooltip.clickToTogglePeriod' |
    'tooltip.combinedTotal' |
    'tooltip.copySummary' |
    'tooltip.copySummaryTitle' |
    'tooltip.input' |
    'tooltip.logDirectoryNotFound' |
    'tooltip.model' |
    'tooltip.noUsageThisMonth' |
    'tooltip.output' |
    'tooltip.period' |
    'tooltip.rate' |
    'tooltip.rtkTitle' |
    'tooltip.saved' |
    'tooltip.thisMonth' |
    'tooltip.title' |
    'tooltip.today' |
    'tooltip.total' |
    'tooltip.updated';

type TranslationMessages = Record<TranslationKey, string>;

const MESSAGES: Record<SupportedLocale, TranslationMessages> = {
    en: {
        'action.openSettings': 'Open Settings',
        'alert.dailyCostExceeded': "otak-usage daily cost alert: today's total is {total}, above your daily alert threshold of {threshold}.",
        'message.summaryCopied': 'otak-usage: summary copied to clipboard',
        'tooltip.allTime': 'All Time',
        'tooltip.clickToTogglePeriod': 'Click to toggle period',
        'tooltip.combinedTotal': 'OpenAI + Claude Total',
        'tooltip.copySummary': 'Copy Summary',
        'tooltip.copySummaryTitle': 'Copy the usage summary to the clipboard',
        'tooltip.input': 'Input',
        'tooltip.logDirectoryNotFound': 'Log directory not found.',
        'tooltip.model': 'Model',
        'tooltip.noUsageThisMonth': 'No usage this month.',
        'tooltip.output': 'Output',
        'tooltip.period': 'Period',
        'tooltip.rate': 'Rate',
        'tooltip.rtkTitle': 'RTK — Token Savings',
        'tooltip.saved': 'Saved',
        'tooltip.thisMonth': 'This Month',
        'tooltip.title': 'otak-usage — API-equivalent cost',
        'tooltip.today': 'Today',
        'tooltip.total': 'Total',
        'tooltip.updated': 'Updated',
    },
    ar: {
        'action.openSettings': 'فتح الإعدادات',
        'alert.dailyCostExceeded': 'تنبيه تكلفة otak-usage اليومية: إجمالي اليوم هو {total}، وقد تجاوز حد التنبيه اليومي {threshold}.',
        'message.summaryCopied': 'otak-usage: تم نسخ الملخص إلى الحافظة',
        'tooltip.allTime': 'كل الأوقات',
        'tooltip.clickToTogglePeriod': 'انقر لتبديل الفترة',
        'tooltip.combinedTotal': 'إجمالي OpenAI + Claude',
        'tooltip.copySummary': 'نسخ الملخص',
        'tooltip.copySummaryTitle': 'نسخ ملخص الاستخدام إلى الحافظة',
        'tooltip.input': 'الإدخال',
        'tooltip.logDirectoryNotFound': 'لم يتم العثور على مجلد السجلات.',
        'tooltip.model': 'النموذج',
        'tooltip.noUsageThisMonth': 'لا يوجد استخدام هذا الشهر.',
        'tooltip.output': 'الإخراج',
        'tooltip.period': 'الفترة',
        'tooltip.rate': 'النسبة',
        'tooltip.rtkTitle': 'RTK — توفير الرموز',
        'tooltip.saved': 'المحفوظ',
        'tooltip.thisMonth': 'هذا الشهر',
        'tooltip.title': 'otak-usage — تكلفة مكافئة لواجهة API',
        'tooltip.today': 'اليوم',
        'tooltip.total': 'الإجمالي',
        'tooltip.updated': 'تم التحديث',
    },
    de: {
        'action.openSettings': 'Einstellungen öffnen',
        'alert.dailyCostExceeded': 'otak-usage Tageskostenalarm: Die heutige Summe beträgt {total} und liegt über dem täglichen Grenzwert von {threshold}.',
        'message.summaryCopied': 'otak-usage: Zusammenfassung in die Zwischenablage kopiert',
        'tooltip.allTime': 'Gesamtzeit',
        'tooltip.clickToTogglePeriod': 'Klicken, um den Zeitraum zu wechseln',
        'tooltip.combinedTotal': 'OpenAI + Claude Gesamt',
        'tooltip.copySummary': 'Zusammenfassung kopieren',
        'tooltip.copySummaryTitle': 'Nutzungszusammenfassung in die Zwischenablage kopieren',
        'tooltip.input': 'Eingabe',
        'tooltip.logDirectoryNotFound': 'Protokollverzeichnis nicht gefunden.',
        'tooltip.model': 'Modell',
        'tooltip.noUsageThisMonth': 'Keine Nutzung in diesem Monat.',
        'tooltip.output': 'Ausgabe',
        'tooltip.period': 'Zeitraum',
        'tooltip.rate': 'Rate',
        'tooltip.rtkTitle': 'RTK — Token-Ersparnis',
        'tooltip.saved': 'Gespart',
        'tooltip.thisMonth': 'Dieser Monat',
        'tooltip.title': 'otak-usage — API-äquivalente Kosten',
        'tooltip.today': 'Heute',
        'tooltip.total': 'Gesamt',
        'tooltip.updated': 'Aktualisiert',
    },
    es: {
        'action.openSettings': 'Abrir configuración',
        'alert.dailyCostExceeded': 'Alerta de coste diario de otak-usage: el total de hoy es {total}, por encima del umbral diario de {threshold}.',
        'message.summaryCopied': 'otak-usage: resumen copiado al portapapeles',
        'tooltip.allTime': 'Todo el tiempo',
        'tooltip.clickToTogglePeriod': 'Haz clic para cambiar el periodo',
        'tooltip.combinedTotal': 'Total de OpenAI + Claude',
        'tooltip.copySummary': 'Copiar resumen',
        'tooltip.copySummaryTitle': 'Copiar el resumen de uso al portapapeles',
        'tooltip.input': 'Entrada',
        'tooltip.logDirectoryNotFound': 'No se encontró el directorio de registros.',
        'tooltip.model': 'Modelo',
        'tooltip.noUsageThisMonth': 'Sin uso este mes.',
        'tooltip.output': 'Salida',
        'tooltip.period': 'Periodo',
        'tooltip.rate': 'Tasa',
        'tooltip.rtkTitle': 'RTK — Ahorro de tokens',
        'tooltip.saved': 'Ahorrado',
        'tooltip.thisMonth': 'Este mes',
        'tooltip.title': 'otak-usage — coste equivalente de API',
        'tooltip.today': 'Hoy',
        'tooltip.total': 'Total',
        'tooltip.updated': 'Actualizado',
    },
    fr: {
        'action.openSettings': 'Ouvrir les paramètres',
        'alert.dailyCostExceeded': "Alerte de coût quotidien otak-usage : le total d'aujourd'hui est de {total}, au-dessus du seuil quotidien de {threshold}.",
        'message.summaryCopied': 'otak-usage : résumé copié dans le presse-papiers',
        'tooltip.allTime': 'Depuis toujours',
        'tooltip.clickToTogglePeriod': 'Cliquez pour changer de période',
        'tooltip.combinedTotal': 'Total OpenAI + Claude',
        'tooltip.copySummary': 'Copier le résumé',
        'tooltip.copySummaryTitle': "Copier le résumé d'utilisation dans le presse-papiers",
        'tooltip.input': 'Entrée',
        'tooltip.logDirectoryNotFound': 'Répertoire des journaux introuvable.',
        'tooltip.model': 'Modèle',
        'tooltip.noUsageThisMonth': 'Aucune utilisation ce mois-ci.',
        'tooltip.output': 'Sortie',
        'tooltip.period': 'Période',
        'tooltip.rate': 'Taux',
        'tooltip.rtkTitle': 'RTK — Économies de tokens',
        'tooltip.saved': 'Économisé',
        'tooltip.thisMonth': 'Ce mois-ci',
        'tooltip.title': 'otak-usage — coût équivalent API',
        'tooltip.today': "Aujourd'hui",
        'tooltip.total': 'Total',
        'tooltip.updated': 'Mis à jour',
    },
    hi: {
        'action.openSettings': 'सेटिंग खोलें',
        'alert.dailyCostExceeded': 'otak-usage दैनिक लागत अलर्ट: आज का कुल {total} है, जो आपके दैनिक अलर्ट सीमा {threshold} से अधिक है।',
        'message.summaryCopied': 'otak-usage: सारांश क्लिपबोर्ड पर कॉपी किया गया',
        'tooltip.allTime': 'अब तक',
        'tooltip.clickToTogglePeriod': 'अवधि बदलने के लिए क्लिक करें',
        'tooltip.combinedTotal': 'OpenAI + Claude कुल',
        'tooltip.copySummary': 'सारांश कॉपी करें',
        'tooltip.copySummaryTitle': 'उपयोग सारांश क्लिपबोर्ड पर कॉपी करें',
        'tooltip.input': 'इनपुट',
        'tooltip.logDirectoryNotFound': 'लॉग डायरेक्टरी नहीं मिली।',
        'tooltip.model': 'मॉडल',
        'tooltip.noUsageThisMonth': 'इस महीने कोई उपयोग नहीं।',
        'tooltip.output': 'आउटपुट',
        'tooltip.period': 'अवधि',
        'tooltip.rate': 'दर',
        'tooltip.rtkTitle': 'RTK — टोकन बचत',
        'tooltip.saved': 'बचत',
        'tooltip.thisMonth': 'इस महीने',
        'tooltip.title': 'otak-usage — API-समतुल्य लागत',
        'tooltip.today': 'आज',
        'tooltip.total': 'कुल',
        'tooltip.updated': 'अपडेट',
    },
    id: {
        'action.openSettings': 'Buka Pengaturan',
        'alert.dailyCostExceeded': 'Peringatan biaya harian otak-usage: total hari ini {total}, melebihi ambang peringatan harian {threshold}.',
        'message.summaryCopied': 'otak-usage: ringkasan disalin ke clipboard',
        'tooltip.allTime': 'Sepanjang Waktu',
        'tooltip.clickToTogglePeriod': 'Klik untuk mengganti periode',
        'tooltip.combinedTotal': 'Total OpenAI + Claude',
        'tooltip.copySummary': 'Salin Ringkasan',
        'tooltip.copySummaryTitle': 'Salin ringkasan penggunaan ke clipboard',
        'tooltip.input': 'Input',
        'tooltip.logDirectoryNotFound': 'Direktori log tidak ditemukan.',
        'tooltip.model': 'Model',
        'tooltip.noUsageThisMonth': 'Tidak ada penggunaan bulan ini.',
        'tooltip.output': 'Output',
        'tooltip.period': 'Periode',
        'tooltip.rate': 'Rasio',
        'tooltip.rtkTitle': 'RTK — Penghematan Token',
        'tooltip.saved': 'Dihemat',
        'tooltip.thisMonth': 'Bulan Ini',
        'tooltip.title': 'otak-usage — biaya setara API',
        'tooltip.today': 'Hari Ini',
        'tooltip.total': 'Total',
        'tooltip.updated': 'Diperbarui',
    },
    it: {
        'action.openSettings': 'Apri impostazioni',
        'alert.dailyCostExceeded': 'Avviso costo giornaliero di otak-usage: il totale di oggi è {total}, sopra la soglia giornaliera di {threshold}.',
        'message.summaryCopied': 'otak-usage: riepilogo copiato negli appunti',
        'tooltip.allTime': 'Da sempre',
        'tooltip.clickToTogglePeriod': 'Fai clic per cambiare periodo',
        'tooltip.combinedTotal': 'Totale OpenAI + Claude',
        'tooltip.copySummary': 'Copia riepilogo',
        'tooltip.copySummaryTitle': 'Copia il riepilogo di utilizzo negli appunti',
        'tooltip.input': 'Input',
        'tooltip.logDirectoryNotFound': 'Directory dei log non trovata.',
        'tooltip.model': 'Modello',
        'tooltip.noUsageThisMonth': 'Nessun utilizzo questo mese.',
        'tooltip.output': 'Output',
        'tooltip.period': 'Periodo',
        'tooltip.rate': 'Tasso',
        'tooltip.rtkTitle': 'RTK — Risparmio token',
        'tooltip.saved': 'Risparmiati',
        'tooltip.thisMonth': 'Questo mese',
        'tooltip.title': 'otak-usage — costo equivalente API',
        'tooltip.today': 'Oggi',
        'tooltip.total': 'Totale',
        'tooltip.updated': 'Aggiornato',
    },
    ja: {
        'action.openSettings': '設定を開く',
        'alert.dailyCostExceeded': 'otak-usage の本日合計が {total} になり、1日あたりのアラートしきい値 {threshold} を超えました。',
        'message.summaryCopied': 'otak-usage: サマリーをクリップボードにコピーしました',
        'tooltip.allTime': '全期間',
        'tooltip.clickToTogglePeriod': 'クリックして期間を切り替え',
        'tooltip.combinedTotal': 'OpenAI + Claude 合計',
        'tooltip.copySummary': 'サマリーをコピー',
        'tooltip.copySummaryTitle': '使用量サマリーをクリップボードにコピー',
        'tooltip.input': '入力',
        'tooltip.logDirectoryNotFound': 'ログディレクトリが見つかりません。',
        'tooltip.model': 'モデル',
        'tooltip.noUsageThisMonth': '今月の使用量はありません。',
        'tooltip.output': '出力',
        'tooltip.period': '期間',
        'tooltip.rate': '率',
        'tooltip.rtkTitle': 'RTK — トークン節約量',
        'tooltip.saved': '節約',
        'tooltip.thisMonth': '今月',
        'tooltip.title': 'otak-usage — API 相当コスト',
        'tooltip.today': '本日',
        'tooltip.total': '合計',
        'tooltip.updated': '更新',
    },
    ko: {
        'action.openSettings': '설정 열기',
        'alert.dailyCostExceeded': 'otak-usage 일일 비용 알림: 오늘 합계가 {total}이며 일일 알림 기준 {threshold}를 초과했습니다.',
        'message.summaryCopied': 'otak-usage: 요약을 클립보드에 복사했습니다',
        'tooltip.allTime': '전체 기간',
        'tooltip.clickToTogglePeriod': '클릭하여 기간 전환',
        'tooltip.combinedTotal': 'OpenAI + Claude 합계',
        'tooltip.copySummary': '요약 복사',
        'tooltip.copySummaryTitle': '사용량 요약을 클립보드에 복사',
        'tooltip.input': '입력',
        'tooltip.logDirectoryNotFound': '로그 디렉터리를 찾을 수 없습니다.',
        'tooltip.model': '모델',
        'tooltip.noUsageThisMonth': '이번 달 사용량이 없습니다.',
        'tooltip.output': '출력',
        'tooltip.period': '기간',
        'tooltip.rate': '비율',
        'tooltip.rtkTitle': 'RTK — 토큰 절약',
        'tooltip.saved': '절약',
        'tooltip.thisMonth': '이번 달',
        'tooltip.title': 'otak-usage — API 상당 비용',
        'tooltip.today': '오늘',
        'tooltip.total': '합계',
        'tooltip.updated': '업데이트',
    },
    'pt-br': {
        'action.openSettings': 'Abrir configurações',
        'alert.dailyCostExceeded': 'Alerta de custo diário do otak-usage: o total de hoje é {total}, acima do limite diário de {threshold}.',
        'message.summaryCopied': 'otak-usage: resumo copiado para a área de transferência',
        'tooltip.allTime': 'Todo o período',
        'tooltip.clickToTogglePeriod': 'Clique para alternar o período',
        'tooltip.combinedTotal': 'Total OpenAI + Claude',
        'tooltip.copySummary': 'Copiar resumo',
        'tooltip.copySummaryTitle': 'Copiar o resumo de uso para a área de transferência',
        'tooltip.input': 'Entrada',
        'tooltip.logDirectoryNotFound': 'Diretório de logs não encontrado.',
        'tooltip.model': 'Modelo',
        'tooltip.noUsageThisMonth': 'Sem uso neste mês.',
        'tooltip.output': 'Saída',
        'tooltip.period': 'Período',
        'tooltip.rate': 'Taxa',
        'tooltip.rtkTitle': 'RTK — Economia de tokens',
        'tooltip.saved': 'Economizado',
        'tooltip.thisMonth': 'Este mês',
        'tooltip.title': 'otak-usage — custo equivalente de API',
        'tooltip.today': 'Hoje',
        'tooltip.total': 'Total',
        'tooltip.updated': 'Atualizado',
    },
    ru: {
        'action.openSettings': 'Открыть настройки',
        'alert.dailyCostExceeded': 'Ежедневное предупреждение otak-usage: сумма за сегодня {total}, что выше дневного порога {threshold}.',
        'message.summaryCopied': 'otak-usage: сводка скопирована в буфер обмена',
        'tooltip.allTime': 'За все время',
        'tooltip.clickToTogglePeriod': 'Нажмите, чтобы переключить период',
        'tooltip.combinedTotal': 'Итого OpenAI + Claude',
        'tooltip.copySummary': 'Скопировать сводку',
        'tooltip.copySummaryTitle': 'Скопировать сводку использования в буфер обмена',
        'tooltip.input': 'Ввод',
        'tooltip.logDirectoryNotFound': 'Каталог журналов не найден.',
        'tooltip.model': 'Модель',
        'tooltip.noUsageThisMonth': 'Нет использования в этом месяце.',
        'tooltip.output': 'Вывод',
        'tooltip.period': 'Период',
        'tooltip.rate': 'Доля',
        'tooltip.rtkTitle': 'RTK — Экономия токенов',
        'tooltip.saved': 'Сэкономлено',
        'tooltip.thisMonth': 'Этот месяц',
        'tooltip.title': 'otak-usage — стоимость, эквивалентная API',
        'tooltip.today': 'Сегодня',
        'tooltip.total': 'Итого',
        'tooltip.updated': 'Обновлено',
    },
    tr: {
        'action.openSettings': 'Ayarları Aç',
        'alert.dailyCostExceeded': 'otak-usage günlük maliyet uyarısı: bugünün toplamı {total}; günlük uyarı eşiği {threshold} üzerinde.',
        'message.summaryCopied': 'otak-usage: özet panoya kopyalandı',
        'tooltip.allTime': 'Tüm Zamanlar',
        'tooltip.clickToTogglePeriod': 'Dönemi değiştirmek için tıklayın',
        'tooltip.combinedTotal': 'OpenAI + Claude Toplamı',
        'tooltip.copySummary': 'Özeti Kopyala',
        'tooltip.copySummaryTitle': 'Kullanım özetini panoya kopyala',
        'tooltip.input': 'Girdi',
        'tooltip.logDirectoryNotFound': 'Günlük dizini bulunamadı.',
        'tooltip.model': 'Model',
        'tooltip.noUsageThisMonth': 'Bu ay kullanım yok.',
        'tooltip.output': 'Çıktı',
        'tooltip.period': 'Dönem',
        'tooltip.rate': 'Oran',
        'tooltip.rtkTitle': 'RTK — Token Tasarrufu',
        'tooltip.saved': 'Tasarruf',
        'tooltip.thisMonth': 'Bu Ay',
        'tooltip.title': 'otak-usage — API eşdeğeri maliyet',
        'tooltip.today': 'Bugün',
        'tooltip.total': 'Toplam',
        'tooltip.updated': 'Güncellendi',
    },
    vi: {
        'action.openSettings': 'Mở cài đặt',
        'alert.dailyCostExceeded': 'Cảnh báo chi phí hằng ngày của otak-usage: tổng hôm nay là {total}, vượt ngưỡng cảnh báo hằng ngày {threshold}.',
        'message.summaryCopied': 'otak-usage: đã sao chép tóm tắt vào clipboard',
        'tooltip.allTime': 'Từ trước đến nay',
        'tooltip.clickToTogglePeriod': 'Nhấp để đổi kỳ',
        'tooltip.combinedTotal': 'Tổng OpenAI + Claude',
        'tooltip.copySummary': 'Sao chép tóm tắt',
        'tooltip.copySummaryTitle': 'Sao chép tóm tắt sử dụng vào clipboard',
        'tooltip.input': 'Đầu vào',
        'tooltip.logDirectoryNotFound': 'Không tìm thấy thư mục nhật ký.',
        'tooltip.model': 'Mô hình',
        'tooltip.noUsageThisMonth': 'Không có sử dụng trong tháng này.',
        'tooltip.output': 'Đầu ra',
        'tooltip.period': 'Kỳ',
        'tooltip.rate': 'Tỷ lệ',
        'tooltip.rtkTitle': 'RTK — Tiết kiệm token',
        'tooltip.saved': 'Đã tiết kiệm',
        'tooltip.thisMonth': 'Tháng này',
        'tooltip.title': 'otak-usage — chi phí tương đương API',
        'tooltip.today': 'Hôm nay',
        'tooltip.total': 'Tổng',
        'tooltip.updated': 'Đã cập nhật',
    },
    'zh-cn': {
        'action.openSettings': '打开设置',
        'alert.dailyCostExceeded': 'otak-usage 每日费用提醒：今天合计为 {total}，已超过每日提醒阈值 {threshold}。',
        'message.summaryCopied': 'otak-usage：摘要已复制到剪贴板',
        'tooltip.allTime': '全部时间',
        'tooltip.clickToTogglePeriod': '点击切换周期',
        'tooltip.combinedTotal': 'OpenAI + Claude 合计',
        'tooltip.copySummary': '复制摘要',
        'tooltip.copySummaryTitle': '将使用量摘要复制到剪贴板',
        'tooltip.input': '输入',
        'tooltip.logDirectoryNotFound': '未找到日志目录。',
        'tooltip.model': '模型',
        'tooltip.noUsageThisMonth': '本月无使用量。',
        'tooltip.output': '输出',
        'tooltip.period': '周期',
        'tooltip.rate': '比率',
        'tooltip.rtkTitle': 'RTK — Token 节省',
        'tooltip.saved': '节省',
        'tooltip.thisMonth': '本月',
        'tooltip.title': 'otak-usage — API 等效费用',
        'tooltip.today': '今天',
        'tooltip.total': '合计',
        'tooltip.updated': '已更新',
    },
    'zh-tw': {
        'action.openSettings': '開啟設定',
        'alert.dailyCostExceeded': 'otak-usage 每日費用提醒：今天合計為 {total}，已超過每日提醒門檻 {threshold}。',
        'message.summaryCopied': 'otak-usage：摘要已複製到剪貼簿',
        'tooltip.allTime': '全部時間',
        'tooltip.clickToTogglePeriod': '點擊切換期間',
        'tooltip.combinedTotal': 'OpenAI + Claude 合計',
        'tooltip.copySummary': '複製摘要',
        'tooltip.copySummaryTitle': '將使用量摘要複製到剪貼簿',
        'tooltip.input': '輸入',
        'tooltip.logDirectoryNotFound': '找不到記錄目錄。',
        'tooltip.model': '模型',
        'tooltip.noUsageThisMonth': '本月沒有使用量。',
        'tooltip.output': '輸出',
        'tooltip.period': '期間',
        'tooltip.rate': '比率',
        'tooltip.rtkTitle': 'RTK — Token 節省',
        'tooltip.saved': '節省',
        'tooltip.thisMonth': '本月',
        'tooltip.title': 'otak-usage — API 等效費用',
        'tooltip.today': '今天',
        'tooltip.total': '合計',
        'tooltip.updated': '已更新',
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
