import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface UseScrollAnchorOptions {
  readonly messageIds: readonly string[];
  readonly contentVersion: string;
  readonly announcementText?: string;
}

interface ScrollSnapshot {
  readonly ids: readonly string[];
  readonly height: number;
}

/** Follows new output only while the reader is already at the end of the list. */
export function useScrollAnchor({
  messageIds,
  contentVersion,
  announcementText = '',
}: UseScrollAnchorOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousSnapshot = useRef<ScrollSnapshot>({ ids: [], height: 0 });
  const atBottomRef = useRef(true);
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAnnouncement = useRef('');
  const lastAnnouncementAt = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const jumpToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    atBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight - container.clientHeight - container.scrollTop <= 96;
    atBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previous = previousSnapshot.current;
    const height = container.scrollHeight;
    const previousFirstMessageId = previous.ids[0];
    const prependedHistory =
      previous.ids.length > 0 &&
      messageIds.length > previous.ids.length &&
      previousFirstMessageId !== undefined &&
      messageIds[0] !== previousFirstMessageId &&
      messageIds.includes(previousFirstMessageId);

    if (messageIds.length === 0) {
      container.scrollTop = 0;
      atBottomRef.current = true;
      setShowJumpToLatest(false);
    } else if (atBottomRef.current) {
      jumpToLatest();
    } else if (prependedHistory) {
      container.scrollTop += height - previous.height;
    }
    previousSnapshot.current = { ids: [...messageIds], height };
  }, [contentVersion, jumpToLatest, messageIds]);

  useEffect(() => {
    if (announcementText.length === 0) return;
    pendingAnnouncement.current = announcementText.slice(-240);
    if (announcementTimer.current !== null) return;
    const wait = Math.max(0, 900 - (Date.now() - lastAnnouncementAt.current));
    announcementTimer.current = setTimeout(() => {
      announcementTimer.current = null;
      lastAnnouncementAt.current = Date.now();
      setAnnouncement(pendingAnnouncement.current);
    }, wait);
  }, [announcementText]);

  useEffect(
    () => () => {
      if (announcementTimer.current !== null) clearTimeout(announcementTimer.current);
    },
    [],
  );

  return { containerRef, onScroll, jumpToLatest, showJumpToLatest, announcement };
}
