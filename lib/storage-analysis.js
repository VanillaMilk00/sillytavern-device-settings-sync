import { entryBytes, isInternalKey, planDelete } from './storage-model.js';

const CORE = /^(?:settings|theme|custom_themes|power_user|extensions?_settings|selected_character|selected_group|movingui|speech_recognition|main_api|user_avatar|quick_reply|expression|language|i18n|trackdynamictranslate|eventtracing)$/iu;
const CREDENTIAL = /(?:credential|token|secret|password|api.?key|oauth|auth|login|憑證|凭证|密碼|密码|令牌|金鑰|密钥|登入|登录)/iu;
const HISTORY = /(?:history|draft|chat|memory|snapshot|session|歷史|历史|草稿|聊天|記憶|记忆)/iu;
const SETTINGS = /(?:^|[:._/-])(?:settings?|config|preferences?|themes?)(?:$|[:._/-])|設定|设置|配置/iu;
const CANDIDATES = [
    ['cleanupCache', /(?:快取|缓存|(?:^|[:._/-])(?:cache|cached|caches)(?:$|[:._/-]))/iu],
    ['cleanupTemp', /(?:暫存|暂存|臨時|临时|(?:^|[:._/-])(?:temp|temporary|tmp)(?:$|[:._/-]))/iu],
    ['cleanupDebug', /(?:除錯|调试|(?:^|[:._/-])debug(?:$|[:._/-]))/iu],
    ['cleanupLog', /(?:日誌|日志|(?:^|[:._/-])logs?(?:$|[:._/-]))/iu],
];

export function classifyCleanup(key) {
    // Protection always wins over cache/temp matching, including mixed names.
    if (isInternalKey(key)) return { category: 'protected', reason: 'cleanupInternal' };
    if (CREDENTIAL.test(key)) return { category: 'protected', reason: 'cleanupCredential' };
    if (HISTORY.test(key)) return { category: 'protected', reason: 'review' };
    if (CORE.test(key) || SETTINGS.test(key)) return { category: 'protected', reason: 'cleanupSettings' };
    if (/^tt:/iu.test(key)) return { category: 'review', reason: 'cleanupPlatform' };
    for (const [reason, pattern] of CANDIDATES) {
        if (pattern.test(key)) return { category: 'recommended', reason };
    }
    return { category: 'review', reason: 'cleanupUnknown' };
}

export function analyzeCleanup(values) {
    return [...values].map(([key, value]) => ({ key, bytes: entryBytes(key, value), ...classifyCleanup(key) }))
        .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
}

export function planCleanup(before, keys) {
    return planDelete(before, [...keys].filter(key => classifyCleanup(key).category !== 'protected'));
}

// These are display hints only: never append an extension to a storage key or
// change the JSON archive format. A key suffix and a value type may disagree.
const EXTENSION = /\.(json|txt|log|csv|tsv|yaml|yml|xml|html|htm|js|css|md|svg|png|jpe?g|webp|gif|avif|pdf|bin)$/iu;
export function describeEntry(key, value) {
    const suffix = key.match(EXTENSION)?.[0] || '';
    let type = 'typeText';
    let inferred = '.txt';
    if (/^data:[^,]*,/iu.test(value)) type = 'typeData';
    else if (/^blob:/iu.test(value)) type = 'typeBlob';
    else if (value.length > 1024 * 1024) type = 'typeLarge';
    else if (/^\s*[[{]/u.test(value)) {
        try {
            JSON.parse(value);
            type = 'typeJson';
            inferred = '.json';
        } catch { /* Invalid JSON remains raw text; never evaluate it. */ }
    }
    return { extension: suffix || inferred, inferred: !suffix, type };
}
