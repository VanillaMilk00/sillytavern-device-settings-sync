import { translate } from '../../../../i18n.js';

// One catalog for manager UI, server error codes and operation feedback.
export const messages = {
    manager: 'Manage localStorage',
    local: 'Local data',
    backups: 'Backups',
    cleanup: 'Cleanup suggestions',
    close: 'Close',
    rescan: 'Rescan',
    exportAll: 'Export all',
    exportSelected: 'Export selected',
    importFile: 'Import file',
    remove: 'Remove selected',
    restore: 'Restore',
    browse: 'Browse',
    export: 'Export',
    back: 'Back to local data',
    search: 'Search keys',
    sortSize: 'Size: largest first',
    sortName: 'Name: A–Z',
    selectAll: 'Select visible',
    clearSelection: 'Clear selection',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    name: 'Name',
    size: 'Estimated size',
    percent: 'Share',
    keys: 'Keys',
    classification: 'Sync classification',
    total: '{count} keys · {size} estimated UTF-16 · {selected} selected',
    capacity: '{count} keys · localStorage estimate: {size}',
    estimateNote: 'Sizes include UTF-16 keys and values, not the browser quota. Exported JSON size may differ.',
    empty: 'No entries.',
    emptyKey: '(empty key)',
    backupEmpty: 'Empty slot',
    slot: 'Slot {number}',
    backupMeta: '{date} · {reason} · {device} · {count} keys · {size}',
    backupHelp: 'Five snapshots shared by this account. Each sync saves the complete localStorage before making changes. Newest first.',
    credentialsNote: 'Full snapshots and exported files include credentials stored in localStorage. Account settings, cookies and IndexedDB are not included.',
    beforeChanges: 'Also back up before importing, restoring or removing local data',
    includeInternal: 'Include sync-internal keys (device identity)',
    merge: 'Merge (keep other keys)',
    replace: 'Replace within the chosen scope',
    preview: 'Preview import',
    apply: 'Apply changes',
    cancel: 'Cancel',
    previewCounts: 'Add: {add} · Overwrite: {overwrite} · Delete: {remove} · Unchanged/skipped: {skip}',
    deletionList: 'Keys to remove',
    confirmChange: 'Apply these changes to this device?',
    confirmDelete: 'Remove {count} keys ({size}) from this device?',
    localOnly: 'This changes only localStorage on this device. Server sync data changes only after a manual upload.',
    automaticBackup: 'A full server backup will be saved first.',
    noAutomaticBackup: 'Automatic backup for local changes is off.',
    changeSuccess: 'Updated {count} keys. Reload the page to apply settings completely.',
    reload: 'Reload to apply',
    noChanges: 'No changes to apply.',
    scopeFull: 'Scope: all localStorage',
    scopePrefix: 'Scope: folder prefix “{prefix}”',
    scopeKeys: 'Scope: {count} exact keys',
    selectionScope: 'Import scope follows the file or the selected folder. Unchecked incoming keys are kept unchanged; replace only removes keys absent from the file.',
    fileSize: 'JSON file: {size}',
    reasonUpload: 'Before upload',
    reasonDownload: 'Before download',
    reasonImport: 'Before import',
    reasonRestore: 'Before restore',
    reasonDelete: 'Before removal',
    candidate: 'Possible cache / temporary / debug data. Review before removal.',
    review: 'History, drafts, credentials or internal data: manual review required.',
    largest: 'Large item. Size alone does not mean it is safe to delete.',
    cleanupHelp: 'Largest ten entries plus possible cache/temp/log entries. Suggestions do not delete anything or infer last-used times.',
    locate: 'Locate in tree',
    portable: 'Syncable setting',
    internal: 'Sync-internal',
    dataCache: 'Data / cache (excluded from sync)',
    customExclude: 'Custom exclusion',
    binary: 'Image / Blob value (excluded from sync)',
    tooLarge: 'Too large for regular sync',
    invalidKey: 'Key excluded from regular sync',
    backupBackendMissing: 'Backup API unavailable. Update the extension and restart the SillyTavern server plugin before syncing.',
    backupNotFound: 'This backup is no longer available. Refresh the five slots.',
    backupConflict: 'The backup operation ID was reused with different data. Start a new operation.',
    invalidArchive: 'Invalid or unsupported localStorage JSON file. Keys and values must be strings with no duplicate keys.',
    archiveTooLarge: 'The JSON file or backup exceeds the 32 MiB limit.',
    stalePreview: 'localStorage changed after this preview. Rescan and review the changes again.',
    writeRolledBack: 'Writing failed (possibly storage quota). Changes made by this operation were rolled back.',
    rollbackFailed: 'Writing failed, and some previous values could not be restored. Export the current data and restore a backup before reloading.',
    storageUnavailable: 'Browser storage is unavailable. Check this site’s storage permissions.',
    operationBusy: 'Another storage operation is in progress.',
    backingUp: 'Saving full backup',
    applying: 'Applying local changes',
    networkError: 'The request failed. Check the connection and try again.',
    requestError: 'Server request failed (HTTP {status}).',
};

export function msg(key, values = {}) {
    return translate(messages[key] || key, 'dss.manager.' + key).replace(/\{(\w+)\}/gu,
        (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

export function errorText(error) {
    if (error?.name === 'SecurityError') return msg('storageUnavailable');
    const text = error?.code && Object.hasOwn(messages, error.code) ? msg(error.code) : error?.message || String(error);
    return error?.code === 'rollbackFailed' && error.details?.failedKeys?.length
        ? text + ' ' + error.details.failedKeys.map(key => key || msg('emptyKey')).join(', ') : text;
}

export function bytes(value) {
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB';
    return (value / (1024 * 1024)).toFixed(2) + ' MiB';
}
