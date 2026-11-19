import { useCallback, useEffect, useState } from 'react';
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Project } from '../types';

export const PROJECTS_PAGE_SIZE = 25;

interface LoadedPage {
  projects: Project[];
  /** Last document of the page, used as the cursor for the next page. */
  lastDoc: QueryDocumentSnapshot | null;
  hasNext: boolean;
}

const toProject = (doc: QueryDocumentSnapshot): Project => {
  const data = doc.data();
  const createdAt = data.createdAt as { toDate?: () => Date } | undefined;
  return {
    id: String(data.projectId ?? doc.id),
    name: String(data.name ?? data.projectId ?? doc.id),
    url: String(data.url ?? ''),
    createdAt: createdAt?.toDate?.() ?? new Date(0),
  };
};

/**
 * The signed-in user's projects, newest first, PROJECTS_PAGE_SIZE at a time.
 * Each page costs one read per project the first time; pages already loaded are kept
 * in memory, so going back costs nothing until refresh() or a different user.
 *
 * Needs the composite index projects(ownerUid ASC, createdAt DESC).
 */
export const useProjectPages = (uid: string | null | undefined) => {
  // Loaded pages belong to one user and one refresh; anything else counts as not loaded,
  // so a different user (or a refresh) starts over from page 1 without a reset effect.
  const [cache, setCache] = useState<{ uid: string; refreshKey: number; pages: LoadedPage[] } | null>(null);
  const [position, setPosition] = useState<{ uid: string | null | undefined; index: number }>({ uid, index: 0 });
  // A failed load is remembered with the request it belongs to, so loading/error state
  // can be derived without setting state at the start of the effect.
  const [failure, setFailure] = useState<{ requestKey: string; message: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const pageIndex = position.uid === uid ? position.index : 0;
  const pages = cache && uid && cache.uid === uid && cache.refreshKey === refreshKey ? cache.pages : [];
  const page = pages[pageIndex];
  // Pages are loaded in order, so a page's cursor exists before it can be requested.
  const cursor = pageIndex > 0 ? pages[pageIndex - 1]?.lastDoc ?? null : null;
  const needsLoad = Boolean(uid) && !page && (pageIndex === 0 || Boolean(cursor));
  const requestKey = `${uid ?? ''}|${refreshKey}|${pageIndex}`;
  const error = failure?.requestKey === requestKey ? failure.message : '';
  const isLoading = needsLoad && !error;

  useEffect(() => {
    if (!uid || !needsLoad) return;
    let active = true;

    // One extra document tells whether a next page exists without a count() query.
    const constraints = [
      where('ownerUid', '==', uid),
      orderBy('createdAt', 'desc'),
      ...(cursor ? [startAfter(cursor)] : []),
      limit(PROJECTS_PAGE_SIZE + 1),
    ];
    getDocs(query(collection(db, 'projects'), ...constraints))
      .then(snapshot => {
        if (!active) return;
        const docs = snapshot.docs.slice(0, PROJECTS_PAGE_SIZE);
        const loaded: LoadedPage = {
          projects: docs.map(toProject),
          lastDoc: docs.at(-1) ?? null,
          hasNext: snapshot.docs.length > PROJECTS_PAGE_SIZE,
        };
        setCache(previous => {
          const samePages = previous && previous.uid === uid && previous.refreshKey === refreshKey
            ? [...previous.pages]
            : [];
          samePages[pageIndex] = loaded;
          return { uid, refreshKey, pages: samePages };
        });
      })
      .catch(loadError => {
        console.error('Could not load projects:', loadError);
        if (active) {
          setFailure({
            requestKey,
            message: loadError instanceof Error ? loadError.message : 'โหลดรายการโปรเจคไม่สำเร็จ',
          });
        }
      });

    return () => { active = false; };
  }, [uid, pageIndex, refreshKey, cursor, needsLoad, requestKey]);

  const nextPage = useCallback(() => {
    if (page?.hasNext) setPosition({ uid, index: pageIndex + 1 });
  }, [page, uid, pageIndex]);
  const previousPage = useCallback(() => {
    setPosition({ uid, index: Math.max(0, pageIndex - 1) });
  }, [uid, pageIndex]);
  const refresh = useCallback(() => {
    setPosition({ uid, index: 0 });
    setRefreshKey(key => key + 1);
  }, [uid]);

  return {
    projects: page?.projects ?? [],
    pageIndex,
    hasNext: page?.hasNext ?? false,
    hasPrevious: pageIndex > 0,
    isLoading,
    error,
    nextPage,
    previousPage,
    refresh,
  };
};
