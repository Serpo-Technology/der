/**
 * Integration Tests: Sharing and Collaboration Functionality
 * Tests the complete sharing workflow and collaboration features
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SharingService } from '../../services/persistence/SharingService';
import { BookmarkManager } from '../../services/persistence/BookmarkManager';
import { PersistenceService } from '../../services/persistence/PersistenceService';
import { ExperienceEditorService } from '../../services/edit-preservation/ExperienceEditorService';
import { Contract } from '../../models/contract';
import type { ShareableExperience, BookmarkData, CollaborationSession } from '../../types/persistence';

// Mock external dependencies
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('Sharing and Collaboration Integration', () => {
  let sharingService: SharingService;
  let bookmarkManager: BookmarkManager;
  let persistenceService: PersistenceService;
  let editorService: ExperienceEditorService;

  const mockContract: Contract = {
    name: 'Shared Dashboard',
    version: '1.0.0',
    elements: [
      {
        id: 'title',
        type: 'text',
        properties: {
          text: 'Analytics Dashboard',
          fontSize: '24px',
          fontWeight: 'bold'
        },
        dataBindings: [],
        eventBindings: []
      },
      {
        id: 'chart-1',
        type: 'chart',
        properties: {
          chartType: 'line',
          title: 'Revenue Over Time'
        },
        dataBindings: [
          {
            property: 'data',
            source: {
              type: 'operation',
              operationId: 'fetch-revenue-data'
            }
          }
        ],
        eventBindings: []
      },
      {
        id: 'refresh-button',
        type: 'button',
        properties: {
          text: 'Refresh Data',
          backgroundColor: '#007bff'
        },
        dataBindings: [],
        eventBindings: [
          {
            event: 'onClick',
            action: {
              type: 'executeOperation',
              operationId: 'refresh-data'
            }
          }
        ]
      }
    ],
    operations: [
      {
        id: 'fetch-revenue-data',
        type: 'api-call',
        inputMappings: []
      },
      {
        id: 'refresh-data',
        type: 'api-call',
        inputMappings: []
      }
    ],
    operationBindings: []
  };

  beforeEach(async () => {
    sharingService = new SharingService();
    bookmarkManager = new BookmarkManager();
    persistenceService = new PersistenceService();
    editorService = new ExperienceEditorService();

    // Mock storage operations
    vi.spyOn(persistenceService, 'saveExperience').mockResolvedValue(undefined);
    vi.spyOn(persistenceService, 'loadExperience').mockResolvedValue(mockContract);
  });

  describe('Experience Sharing', () => {
    it('should create shareable experience with metadata', async () => {
      const experienceId = 'dashboard-001';
      const userId = 'user-123';
      
      const shareableExperience = await sharingService.createShareableExperience(
        experienceId,
        mockContract,
        {
          title: 'My Analytics Dashboard',
          description: 'A comprehensive dashboard for tracking business metrics',
          tags: ['analytics', 'dashboard', 'business'],
          isPublic: true,
          allowEditing: false,
          createdBy: userId
        }
      );

      expect(shareableExperience).toBeDefined();
      expect(shareableExperience.id).toBeDefined();
      expect(shareableExperience.metadata.title).toBe('My Analytics Dashboard');
      expect(shareableExperience.metadata.isPublic).toBe(true);
      expect(shareableExperience.contract).toEqual(mockContract);
      expect(shareableExperience.checksum).toBeDefined();
    });

    it('should generate unique share URLs', async () => {
      const experienceId = 'dashboard-001';
      
      const shareableExperience = await sharingService.createShareableExperience(
        experienceId,
        mockContract,
        {
          title: 'Dashboard',
          isPublic: true,
          createdBy: 'user-123'
        }
      );

      const shareUrl = await sharingService.generateShareUrl(shareableExperience.id);
      
      expect(shareUrl).toMatch(/^https?:\/\/.+\/share\/[a-zA-Z0-9-]+$/);
      expect(shareUrl).toContain(shareableExperience.id);
    });

    it('should handle private sharing with access controls', async () => {
      const experienceId = 'private-dashboard';
      const ownerId = 'owner-123';
      const collaboratorId = 'collab-456';
      
      const privateExperience = await sharingService.createShareableExperience(
        experienceId,
        mockContract,
        {
          title: 'Private Dashboard',
          isPublic: false,
          allowEditing: true,
          createdBy: ownerId,
          allowedUsers: [collaboratorId]
        }
      );

      // Owner should have access
      const ownerAccess = await sharingService.checkAccess(privateExperience.id, ownerId);
      expect(ownerAccess.hasAccess).toBe(true);
      expect(ownerAccess.permissions.canEdit).toBe(true);

      // Collaborator should have access
      const collabAccess = await sharingService.checkAccess(privateExperience.id, collaboratorId);
      expect(collabAccess.hasAccess).toBe(true);
      expect(collabAccess.permissions.canEdit).toBe(true);

      // Random user should not have access
      const randomAccess = await sharingService.checkAccess(privateExperience.id, 'random-user');
      expect(randomAccess.hasAccess).toBe(false);
    });

    it('should support experience versioning for shared experiences', async () => {
      const experienceId = 'versioned-dashboard';
      const userId = 'user-123';
      
      // Create initial shared experience
      const v1Experience = await sharingService.createShareableExperience(
        experienceId,
        mockContract,
        {
          title: 'Dashboard v1',
          version: '1.0.0',
          isPublic: true,
          createdBy: userId
        }
      );

      // Update contract
      const updatedContract: Contract = {
        ...mockContract,
        version: '1.1.0',
        elements: [
          ...mockContract.elements,
          {
            id: 'new-chart',
            type: 'chart',
            properties: {
              chartType: 'bar',
              title: 'Sales by Region'
            },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      // Create new version
      const v2Experience = await sharingService.updateSharedExperience(
        v1Experience.id,
        updatedContract,
        {
          version: '1.1.0',
          changeLog: 'Added sales by region chart'
        }
      );

      expect(v2Experience.metadata.version).toBe('1.1.0');
      expect(v2Experience.contract.elements).toHaveLength(4);

      // Should be able to access version history
      const versions = await sharingService.getVersionHistory(v1Experience.id);
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe('1.0.0');
      expect(versions[1].version).toBe('1.1.0');
    });
  });

  describe('Experience Import and Duplication', () => {
    it('should import shared experience from URL', async () => {
      const shareUrl = 'https://example.com/share/shared-dashboard-123';
      const importingUserId = 'importer-456';
      
      // Mock the shared experience data
      const sharedExperience: ShareableExperience = {
        id: 'shared-dashboard-123',
        experienceId: 'original-dashboard',
        contract: mockContract,
        metadata: {
          title: 'Imported Dashboard',
          description: 'A shared analytics dashboard',
          isPublic: true,
          createdBy: 'original-user',
          createdAt: new Date(),
          updatedAt: new Date()
        },
        checksum: 'abc123'
      };

      vi.spyOn(sharingService, 'getSharedExperience').mockResolvedValue(sharedExperience);

      const importedExperience = await sharingService.importFromUrl(shareUrl, importingUserId);
      
      expect(importedExperience).toBeDefined();
      expect(importedExperience.experienceId).not.toBe(sharedExperience.experienceId);
      expect(importedExperience.contract).toEqual(mockContract);
      expect(importedExperience.metadata.importedFrom).toBe(sharedExperience.id);
      expect(importedExperience.metadata.importedBy).toBe(importingUserId);
    });

    it('should create independent copy when duplicating experience', async () => {
      const originalExperienceId = 'original-dashboard';
      const duplicatingUserId = 'user-789';
      
      // Create original experience
      await editorService.initializeExperience(originalExperienceId, mockContract);
      
      // Make some edits to original
      await editorService.applyEdit(originalExperienceId, {
        id: 'edit-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'title',
        property: 'text',
        oldValue: 'Analytics Dashboard',
        newValue: 'My Custom Dashboard',
        userId: 'original-owner'
      });

      // Duplicate the experience
      const duplicatedExperience = await sharingService.duplicateExperience(
        originalExperienceId,
        duplicatingUserId,
        {
          title: 'Duplicated Dashboard',
          includeEditHistory: false
        }
      );

      expect(duplicatedExperience.experienceId).not.toBe(originalExperienceId);
      
      // Should have the edited state
      const titleElement = duplicatedExperience.contract.elements.find(el => el.id === 'title');
      expect(titleElement?.properties.text).toBe('My Custom Dashboard');

      // Should be independent - edits to duplicate shouldn't affect original
      await editorService.applyEdit(duplicatedExperience.experienceId, {
        id: 'duplicate-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'title',
        property: 'text',
        oldValue: 'My Custom Dashboard',
        newValue: 'Duplicate Dashboard',
        userId: duplicatingUserId
      });

      const originalContract = await editorService.getCurrentContract(originalExperienceId);
      const originalTitle = originalContract.elements.find(el => el.id === 'title');
      expect(originalTitle?.properties.text).toBe('My Custom Dashboard'); // Unchanged
    });

    it('should validate checksums during import', async () => {
      const shareUrl = 'https://example.com/share/corrupted-dashboard';
      const importingUserId = 'importer-456';
      
      const corruptedExperience: ShareableExperience = {
        id: 'corrupted-dashboard',
        experienceId: 'original',
        contract: mockContract,
        metadata: {
          title: 'Corrupted Dashboard',
          isPublic: true,
          createdBy: 'original-user',
          createdAt: new Date(),
          updatedAt: new Date()
        },
        checksum: 'invalid-checksum'
      };

      vi.spyOn(sharingService, 'getSharedExperience').mockResolvedValue(corruptedExperience);
      vi.spyOn(sharingService, 'validateChecksum').mockReturnValue(false);

      await expect(
        sharingService.importFromUrl(shareUrl, importingUserId)
      ).rejects.toThrow('Checksum validation failed');
    });
  });

  describe('Bookmarking and Collections', () => {
    it('should bookmark shared experiences', async () => {
      const userId = 'user-123';
      const shareableExperience: ShareableExperience = {
        id: 'bookmarkable-dashboard',
        experienceId: 'dashboard-001',
        contract: mockContract,
        metadata: {
          title: 'Bookmarkable Dashboard',
          description: 'A great dashboard to bookmark',
          tags: ['analytics', 'favorite'],
          isPublic: true,
          createdBy: 'creator-456',
          createdAt: new Date(),
          updatedAt: new Date()
        },
        checksum: 'abc123'
      };

      const bookmark = await bookmarkManager.bookmarkExperience(
        userId,
        shareableExperience,
        {
          personalNote: 'Great dashboard for quarterly reviews',
          tags: ['work', 'quarterly'],
          collection: 'Business Dashboards'
        }
      );

      expect(bookmark).toBeDefined();
      expect(bookmark.experienceId).toBe(shareableExperience.id);
      expect(bookmark.userId).toBe(userId);
      expect(bookmark.metadata.personalNote).toBe('Great dashboard for quarterly reviews');
    });

    it('should organize bookmarks into collections', async () => {
      const userId = 'user-123';
      
      // Create multiple bookmarks
      const dashboards = [
        { id: 'sales-dashboard', title: 'Sales Dashboard' },
        { id: 'marketing-dashboard', title: 'Marketing Dashboard' },
        { id: 'finance-dashboard', title: 'Finance Dashboard' }
      ];

      for (const dashboard of dashboards) {
        const shareableExperience: ShareableExperience = {
          id: dashboard.id,
          experienceId: dashboard.id,
          contract: { ...mockContract, name: dashboard.title },
          metadata: {
            title: dashboard.title,
            isPublic: true,
            createdBy: 'creator',
            createdAt: new Date(),
            updatedAt: new Date()
          },
          checksum: 'checksum'
        };

        await bookmarkManager.bookmarkExperience(userId, shareableExperience, {
          collection: 'Business Dashboards'
        });
      }

      // Get bookmarks by collection
      const businessBookmarks = await bookmarkManager.getBookmarksByCollection(
        userId,
        'Business Dashboards'
      );

      expect(businessBookmarks).toHaveLength(3);
      expect(businessBookmarks.map(b => b.experienceId)).toEqual([
        'sales-dashboard',
        'marketing-dashboard',
        'finance-dashboard'
      ]);
    });

    it('should search bookmarks by tags and content', async () => {
      const userId = 'user-123';
      
      // Create bookmarks with different tags
      const bookmarkData = [
        {
          id: 'analytics-1',
          title: 'Revenue Analytics',
          tags: ['analytics', 'revenue', 'finance']
        },
        {
          id: 'analytics-2',
          title: 'User Analytics',
          tags: ['analytics', 'users', 'engagement']
        },
        {
          id: 'report-1',
          title: 'Monthly Report',
          tags: ['report', 'monthly', 'finance']
        }
      ];

      for (const data of bookmarkData) {
        const shareableExperience: ShareableExperience = {
          id: data.id,
          experienceId: data.id,
          contract: { ...mockContract, name: data.title },
          metadata: {
            title: data.title,
            tags: data.tags,
            isPublic: true,
            createdBy: 'creator',
            createdAt: new Date(),
            updatedAt: new Date()
          },
          checksum: 'checksum'
        };

        await bookmarkManager.bookmarkExperience(userId, shareableExperience, {
          tags: data.tags
        });
      }

      // Search by tag
      const analyticsBookmarks = await bookmarkManager.searchBookmarks(userId, {
        tags: ['analytics']
      });
      expect(analyticsBookmarks).toHaveLength(2);

      // Search by title
      const revenueBookmarks = await bookmarkManager.searchBookmarks(userId, {
        query: 'Revenue'
      });
      expect(revenueBookmarks).toHaveLength(1);
      expect(revenueBookmarks[0].experienceId).toBe('analytics-1');
    });
  });

  describe('Real-time Collaboration', () => {
    it('should establish collaboration session', async () => {
      const experienceId = 'collab-dashboard';
      const hostUserId = 'host-123';
      const participantUserId = 'participant-456';
      
      // Host starts collaboration session
      const session = await sharingService.startCollaborationSession(
        experienceId,
        hostUserId,
        {
          allowEditing: true,
          maxParticipants: 5,
          sessionTimeout: 3600000 // 1 hour
        }
      );

      expect(session).toBeDefined();
      expect(session.hostUserId).toBe(hostUserId);
      expect(session.experienceId).toBe(experienceId);
      expect(session.participants).toHaveLength(0);

      // Participant joins session
      const joinResult = await sharingService.joinCollaborationSession(
        session.id,
        participantUserId
      );

      expect(joinResult.success).toBe(true);
      expect(joinResult.session?.participants).toHaveLength(1);
      expect(joinResult.session?.participants[0].userId).toBe(participantUserId);
    });

    it('should synchronize real-time edits between collaborators', async () => {
      const experienceId = 'realtime-dashboard';
      const user1 = 'user-1';
      const user2 = 'user-2';
      
      // Start collaboration session
      const session = await sharingService.startCollaborationSession(experienceId, user1);
      await sharingService.joinCollaborationSession(session.id, user2);

      // Mock real-time edit synchronization
      const editCallbacks: Array<(edit: any) => void> = [];
      vi.spyOn(sharingService, 'subscribeToEdits').mockImplementation((sessionId, callback) => {
        editCallbacks.push(callback);
        return () => {
          const index = editCallbacks.indexOf(callback);
          if (index > -1) editCallbacks.splice(index, 1);
        };
      });

      const receivedEdits: any[] = [];
      sharingService.subscribeToEdits(session.id, (edit) => {
        receivedEdits.push(edit);
      });

      // User 1 makes an edit
      const edit = {
        id: 'realtime-edit-1',
        type: 'property-change',
        elementId: 'title',
        property: 'text',
        newValue: 'Collaborative Dashboard',
        userId: user1,
        timestamp: new Date()
      };

      // Simulate broadcasting edit to all subscribers
      editCallbacks.forEach(callback => callback(edit));

      expect(receivedEdits).toHaveLength(1);
      expect(receivedEdits[0]).toEqual(edit);
    });

    it('should handle participant presence and cursor tracking', async () => {
      const experienceId = 'presence-dashboard';
      const session = await sharingService.startCollaborationSession(experienceId, 'host');
      
      // Multiple users join
      const participants = ['user-1', 'user-2', 'user-3'];
      for (const userId of participants) {
        await sharingService.joinCollaborationSession(session.id, userId);
      }

      // Update user presence
      await sharingService.updatePresence(session.id, 'user-1', {
        isActive: true,
        currentElement: 'title',
        cursorPosition: { x: 100, y: 200 },
        lastSeen: new Date()
      });

      await sharingService.updatePresence(session.id, 'user-2', {
        isActive: true,
        currentElement: 'chart-1',
        cursorPosition: { x: 300, y: 400 },
        lastSeen: new Date()
      });

      // Get current presence information
      const presenceInfo = await sharingService.getPresenceInfo(session.id);
      
      expect(presenceInfo.activeUsers).toBe(2);
      expect(presenceInfo.participants).toHaveLength(3);
      
      const user1Presence = presenceInfo.participants.find(p => p.userId === 'user-1');
      expect(user1Presence?.presence.currentElement).toBe('title');
      expect(user1Presence?.presence.cursorPosition).toEqual({ x: 100, y: 200 });
    });

    it('should handle session cleanup and disconnections', async () => {
      const experienceId = 'cleanup-dashboard';
      const session = await sharingService.startCollaborationSession(experienceId, 'host');
      
      // Add participants
      await sharingService.joinCollaborationSession(session.id, 'user-1');
      await sharingService.joinCollaborationSession(session.id, 'user-2');

      // User leaves session
      await sharingService.leaveCollaborationSession(session.id, 'user-1');
      
      const updatedSession = await sharingService.getCollaborationSession(session.id);
      expect(updatedSession?.participants).toHaveLength(1);
      expect(updatedSession?.participants[0].userId).toBe('user-2');

      // Host ends session
      await sharingService.endCollaborationSession(session.id);
      
      const endedSession = await sharingService.getCollaborationSession(session.id);
      expect(endedSession?.status).toBe('ended');
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large shared experiences efficiently', async () => {
      // Create a large contract with many elements
      const largeContract: Contract = {
        ...mockContract,
        elements: Array.from({ length: 1000 }, (_, i) => ({
          id: `element-${i}`,
          type: 'text',
          properties: { text: `Element ${i}` },
          dataBindings: [],
          eventBindings: []
        }))
      };

      const startTime = Date.now();
      
      const shareableExperience = await sharingService.createShareableExperience(
        'large-experience',
        largeContract,
        {
          title: 'Large Experience',
          isPublic: true,
          createdBy: 'user-123'
        }
      );
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(2000); // Should complete within 2 seconds
      expect(shareableExperience.contract.elements).toHaveLength(1000);
    });

    it('should optimize collaboration for many concurrent users', async () => {
      const experienceId = 'high-traffic-dashboard';
      const session = await sharingService.startCollaborationSession(experienceId, 'host');
      
      // Simulate many users joining
      const userPromises = Array.from({ length: 50 }, (_, i) => 
        sharingService.joinCollaborationSession(session.id, `user-${i}`)
      );

      const startTime = Date.now();
      await Promise.all(userPromises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(3000); // Should handle 50 users within 3 seconds
      
      const finalSession = await sharingService.getCollaborationSession(session.id);
      expect(finalSession?.participants).toHaveLength(50);
    });

    it('should manage memory efficiently with bookmark collections', async () => {
      const userId = 'power-user';
      
      // Create many bookmarks
      const bookmarkPromises = Array.from({ length: 500 }, (_, i) => {
        const shareableExperience: ShareableExperience = {
          id: `experience-${i}`,
          experienceId: `experience-${i}`,
          contract: mockContract,
          metadata: {
            title: `Experience ${i}`,
            isPublic: true,
            createdBy: 'creator',
            createdAt: new Date(),
            updatedAt: new Date()
          },
          checksum: `checksum-${i}`
        };

        return bookmarkManager.bookmarkExperience(userId, shareableExperience, {
          collection: `Collection ${Math.floor(i / 50)}`
        });
      });

      const startTime = Date.now();
      await Promise.all(bookmarkPromises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(5000); // Should handle 500 bookmarks within 5 seconds

      // Verify all bookmarks were created
      const allBookmarks = await bookmarkManager.getAllBookmarks(userId);
      expect(allBookmarks).toHaveLength(500);
    });
  });
});
