// Persistence Layer - Bookmarking, sharing, and versioning services
export { PersistenceService, persistenceService } from './PersistenceService';
export { TauriStorageProvider, tauriStorageProvider } from './TauriStorageProvider';
export { BookmarkManager, bookmarkManager } from './BookmarkManager';
export { SharingService, sharingService } from './SharingService';

export type { BookmarkFilter, BookmarkSortOptions } from './BookmarkManager';
export type { ShareOptions, ShareLink } from './SharingService';