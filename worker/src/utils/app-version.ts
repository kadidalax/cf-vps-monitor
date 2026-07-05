import workerPackage from '../../package.json';

export const APP_VERSION = workerPackage.version?.trim() || 'dev';
