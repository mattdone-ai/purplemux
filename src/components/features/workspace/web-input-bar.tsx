import { sendWebPrompt } from '@/lib/web-prompt-client';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Ban, Loader2, Paperclip, SendHorizontal, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import useWebInput, { clearInputDraft } from '@/hooks/use-web-input';
import useIsMobileDevice from '@/hooks/use-is-mobile-device';
import useMessageHistory from '@/hooks/use-message-history';
import { registerPushTarget } from '@/hooks/use-web-push';
import InterruptDialog from '@/components/features/workspace/interrupt-dialog';
import MessageHistoryPicker from '@/components/features/workspace/message-history-picker';
import { isImageFile, uploadImage } from '@/lib/upload-image-client';
import { uploadFile } from '@/lib/upload-file-client';
import { countImageRefs, waitForImageAttachments } from '@/lib/image-attach-detector';
import type { TCliState } from '@/types/timeline';

const DEFAULT_MAX_ROWS = 5;
const LINE_HEIGHT = 20;
const PADDING_Y = 16;

const escapePathForPrompt = (filePath: string): string =>
  filePath.replace(/[ \t\\'"(){}[\]!#$&;`|*?<>~^%]/g, '\\$&');

interface IAttachment {
  id: string;
  path: string;
  filename: string;
  thumbnail: string;
}

const MAX_ATTACHMENTS = 20;
const ATTACHMENT_CONFIRM_TIMEOUT_MS = 5000;
const ATTACHMENT_POLL_INTERVAL_MS = 100;

interface IWebInputBarProps {
  tabId?: string;
  wsId?: string;
  sessionName?: string;
  agentSessionId?: string | null;
  provider?: 'claude' | 'codex' | 'grok';
  cliState: TCliState;
  sendStdin: (data: string) => void;
  terminalWsConnected: boolean;
  visible: boolean;
  focusTerminal: () => void;
  focusInputRef: React.MutableRefObject<(() => void) | undefined>;
  setInputValueRef: React.MutableRefObject<((v: string) => void) | undefined>;
  maxRows?: number;
  onRestartSession?: () => void;
  onSend?: () => void;
  onOptimisticSend?: (text: string) => void;
  onAddPendingMessage?: (text: string, options?: { autoHide?: boolean; attachmentPlaceholder?: boolean }) => string;
  onRemovePendingMessage?: (id: string) => void;
  attachFilesRef?: React.MutableRefObject<((files: File[]) => Promise<boolean> | void) | undefined>;
}

const WebInputBar = ({
  tabId,
  wsId,
  sessionName,
  agentSessionId,
  provider = 'claude',
  cliState,
  sendStdin,
  terminalWsConnected,
  visible,
  focusTerminal,
  focusInputRef,
  setInputValueRef,
  maxRows = DEFAULT_MAX_ROWS,
  onRestartSession,
  onSend,
  onOptimisticSend,
  onAddPendingMessage,
  onRemovePendingMessage,
  attachFilesRef,
}: IWebInputBarProps) => {
  const t = useTranslations('terminal');
  const tc = useTranslations('common');
  // Codex and grok both drive a TUI: plain text in, no image-ref confirm flow.
  const isTuiAgent = provider !== 'claude';
  const { entries, isLoading, isError, fetchHistory, addHistory, deleteHistory } =
    useMessageHistory({ wsId, tabId });
  const isMobileDevice = useIsMobileDevice();
  const inactiveMessage = provider === 'codex'
    ? t('codexInactiveMessage')
    : provider === 'grok' ? t('grokInactiveMessage') : t('inputDisabledPlaceholder');

  const handleMessageSent = useCallback(
    (message: string) => {
      addHistory(message);
      onOptimisticSend?.(message);
    },
    [addHistory, onOptimisticSend],
  );
  const { value, setValue, mode, canSend, send, interrupt, textareaRef, focusInput } = useWebInput(
    cliState,
    sendStdin,
    terminalWsConnected,
    {
      tabId,
      onRestartSession,
      onMessageSent: handleMessageSent,
      disabledMessage: inactiveMessage,
      workspaceId: wsId,
      sessionName,
    },
  );

  const [interruptDialogOpen, setInterruptDialogOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [attachments, setAttachments] = useState<IAttachment[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<IAttachment[]>([]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.thumbnail));
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      setAttachments((prev) => {
        prev.forEach((a) => URL.revokeObjectURL(a.thumbnail));
        return [];
      });
    }
  }, [visible]);

  useEffect(() => {
    focusInputRef.current = focusInput;
    setInputValueRef.current = setValue;
    return () => {
      focusInputRef.current = undefined;
      setInputValueRef.current = undefined;
    };
  }, [focusInput, focusInputRef, setValue, setInputValueRef]);

  useEffect(() => {
    if (!visible) {
      setValue('');
    }
  }, [visible, setValue]);


  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    if (!value) return;
    const maxHeight = LINE_HEIGHT * maxRows + PADDING_Y;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [textareaRef, maxRows, value]);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const dispatch = useCallback(async () => {
    if (!canSend || isDispatching) return;
    const trimmed = value.trim();
    const hasText = trimmed.length > 0;
    const hasAttach = attachments.length > 0;
    if (!hasText && !hasAttach) return;

    if (!hasAttach) {
      onSend?.();
      if (agentSessionId) registerPushTarget(agentSessionId);
      await send();
      return;
    }

    const sentAttachments = [...attachments];
    const text = value;
    const isSlash = trimmed.startsWith('/');

    sentAttachments.forEach((a) => URL.revokeObjectURL(a.thumbnail));
    setAttachments([]);
    setValue('');
    if (tabId) clearInputDraft(tabId);
    if (hasText && !isSlash) {
      addHistory(trimmed);
    }
    onSend?.();
    if (agentSessionId) registerPushTarget(agentSessionId);

    setIsDispatching(true);
    const pendingId = onAddPendingMessage?.(
      t('attachingImages', { count: sentAttachments.length }),
      { autoHide: false, attachmentPlaceholder: true },
    );

    const fetchPane = sessionName
      ? async () => {
          const r = await fetch(`/api/tmux/capture?session=${encodeURIComponent(sessionName)}`);
          if (!r.ok) throw new Error(`capture ${r.status}`);
          const d = (await r.json()) as { content?: string };
          return d.content ?? '';
        }
      : null;

    try {
      const shouldConfirmImageRefs = !isTuiAgent && fetchPane !== null;
      let baselineRefs = 0;
      if (shouldConfirmImageRefs) {
        try {
          baselineRefs = countImageRefs(await fetchPane());
        } catch {
          /* ignore */
        }
      }

      let allConfirmed = true;
      for (const att of sentAttachments) {
        await sendWebPrompt({ workspaceId: wsId, tabId, sessionName }, escapePathForPrompt(att.path), { submit: false, literalPaste: true });
        if (!shouldConfirmImageRefs) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const result = await waitForImageAttachments({
          capture: fetchPane,
          expectedNewRefs: 1,
          baselineRefs,
          timeoutMs: ATTACHMENT_CONFIRM_TIMEOUT_MS,
          pollIntervalMs: ATTACHMENT_POLL_INTERVAL_MS,
        });
        baselineRefs = result.finalCount;
        if (!result.confirmed) {
          allConfirmed = false;
          break;
        }
      }

      if (!allConfirmed) {
        toast.error(t('attachmentNotConfirmed'));
        if (pendingId) onRemovePendingMessage?.(pendingId);
        return;
      }

      await sendWebPrompt({ workspaceId: wsId, tabId, sessionName }, hasText ? ` ${text}` : '');
    } catch (err) {
      if (pendingId) onRemovePendingMessage?.(pendingId);
      toast.error(err instanceof Error ? err.message : 'Prompt delivery failed');
    } finally {
      setIsDispatching(false);
    }
  }, [canSend, isDispatching, value, attachments, send, setValue, onSend, agentSessionId, sessionName, tabId, wsId, addHistory, onAddPendingMessage, onRemovePendingMessage, t, isTuiAgent]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      textareaRef.current?.blur();
      focusTerminal();
      return;
    }

    if (e.key === 'Enter' && !isMobileDevice) {
      if (e.shiftKey) return;
      e.preventDefault();
      dispatch();
      return;
    }
  };

  const handleSendClick = () => {
    dispatch();
    if (isMobileDevice) {
      textareaRef.current?.blur();
    } else {
      textareaRef.current?.focus();
    }
  };

  const handleInterruptClick = () => {
    setInterruptDialogOpen(true);
  };

  const handleInterruptConfirm = () => {
    interrupt();
  };

  const handleFocusIn = () => setIsFocused(true);
  const handleFocusOut = () => setIsFocused(false);

  const handleHistorySelect = useCallback(
    (message: string) => {
      setValue(message);
    },
    [setValue],
  );

  const handleHistoryClose = useCallback(() => {
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [textareaRef]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed) URL.revokeObjectURL(removed.thumbnail);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const insertAtCursor = useCallback((text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const current = textarea.value;
    const focused = typeof document !== 'undefined' && document.activeElement === textarea;
    const start = focused ? textarea.selectionStart ?? current.length : current.length;
    const end = focused ? textarea.selectionEnd ?? current.length : current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const suffix = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
    const inserted = `${prefix}${text}${suffix}`;
    const next = `${before}${inserted}${after}`;
    setValue(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = before.length + inserted.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  }, [setValue, textareaRef]);

  const uploadImagesAsChips = useCallback(async (images: File[]): Promise<void> => {
    if (images.length === 0) return;
    const remainingSlots = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
    if (remainingSlots === 0) {
      toast.error(t('attachmentLimitReached', { max: MAX_ATTACHMENTS }));
      return;
    }
    const accepted = images.slice(0, remainingSlots);
    if (accepted.length < images.length) {
      toast.warning(t('attachmentLimitReached', { max: MAX_ATTACHMENTS }));
    }
    const results = await Promise.all(
      accepted.map(async (file) => ({ file, result: await uploadImage(file, { wsId, tabId }) })),
    );
    const next: IAttachment[] = results.map(({ file, result }) => ({
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      path: result.path,
      filename: file.name || 'image',
      thumbnail: URL.createObjectURL(file),
    }));
    setAttachments((prev) => [...prev, ...next]);
  }, [wsId, tabId, t]);

  const uploadFilesAsPaths = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const results = await Promise.all(files.map((file) => uploadFile(file, { wsId, tabId })));
    const text = results.map((r) => r.path).join(' ');
    if (text.length > 0) insertAtCursor(text);
  }, [wsId, tabId, insertAtCursor]);

  const uploadAndAttach = useCallback(async (files: File[]): Promise<boolean> => {
    if (files.length === 0) return false;
    const images = files.filter(isImageFile);
    const others = files.filter((f) => !isImageFile(f));
    if (images.length === 0 && others.length === 0) return false;
    setIsUploading(true);
    try {
      await Promise.all([uploadImagesAsChips(images), uploadFilesAsPaths(others)]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
    return true;
  }, [uploadImagesAsChips, uploadFilesAsPaths]);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  useEffect(() => {
    if (!attachFilesRef) return;
    attachFilesRef.current = uploadAndAttach;
    return () => {
      if (attachFilesRef.current === uploadAndAttach) attachFilesRef.current = undefined;
    };
  }, [attachFilesRef, uploadAndAttach]);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadAndAttach(Array.from(files));
    e.target.value = '';
  }, [uploadAndAttach]);

  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.files;
    if (!items || items.length === 0) return;
    const files = Array.from(items);
    if (files.length === 0) return;
    e.preventDefault();
    await uploadAndAttach(files);
  }, [uploadAndAttach]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDraggingOver) setIsDraggingOver(true);
  }, [isDraggingOver]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDraggingOver(false);
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    await uploadAndAttach(Array.from(e.dataTransfer.files));
  }, [uploadAndAttach]);

  const isDisabled = mode === 'disabled';
  const hasValue = value.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const canDispatch = canSend && (hasValue || hasAttachments) && !isDispatching;

  return (
    <>
      <div
        className={cn(
          'relative grid',
          visible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div
          className={cn(
            'pointer-events-none absolute bottom-full left-0 right-0 transition-opacity duration-300',
            (isDisabled || !terminalWsConnected) && visible ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden={(!isDisabled && terminalWsConnected) || !visible}
        >
          <div className="mx-auto w-full max-w-content px-3 pb-1">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center px-2 text-[11px] text-muted-foreground/70">
              {terminalWsConnected
                ? <Ban size={10} className="mr-1.5 justify-self-end" />
                : <Loader2 size={10} className="mr-1.5 justify-self-end animate-spin" />}
              <span>{terminalWsConnected ? inactiveMessage : t('connecting')}</span>
              <span />
            </div>
          </div>
        </div>
        <div className="overflow-hidden">
          <div className="mx-auto w-full max-w-content px-3 pt-0 pb-0 animate-in fade-in duration-150">
          <div
            ref={containerRef}
            className={cn(
              'relative z-10 flex flex-col gap-2 rounded-lg border px-3 py-2 transition-colors duration-150',
              isFocused
                ? 'border-ring bg-background'
                : 'border-border bg-black/5 dark:bg-white/5',
              isDraggingOver && 'border-ring bg-accent/40',
            )}
            onFocusCapture={handleFocusIn}
            onBlurCapture={handleFocusOut}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {hasAttachments && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group relative h-14 w-14 overflow-hidden rounded-md border border-border bg-background"
                    title={a.filename}
                  >
                    <img src={a.thumbnail} alt={a.filename} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground/70 text-background opacity-0 transition-opacity hover:bg-foreground group-hover:opacity-100 focus:opacity-100"
                      aria-label={tc('delete')}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
            <div className="flex items-end">
              <MessageHistoryPicker
                entries={entries}
                isLoading={isLoading}
                isError={isError}
                disabled={isDisabled}
                onFetch={fetchHistory}
                onSelect={handleHistorySelect}
                onDelete={deleteHistory}
                onClose={handleHistoryClose}
              />

              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />

              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                onClick={handleAttachClick}
                disabled={isDisabled || isUploading}
                aria-label={t('attachAriaLabel')}
                title={t('attachAriaLabel')}
              >
                {isUploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
              </Button>
            </div>

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t('inputPlaceholder')}
              aria-label={isTuiAgent ? t('codexInputAriaLabel') : t('inputAriaLabel')}
              className="flex-1 resize-none bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              rows={1}
              style={{
                lineHeight: `${LINE_HEIGHT}px`,
                maxHeight: `${LINE_HEIGHT * maxRows + PADDING_Y}px`,
                overflowY: 'auto',
              }}
            />

            {mode === 'interrupt' && !hasValue && !hasAttachments && !isDispatching ? (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-7 w-7 shrink-0 p-0 text-ui-red hover:text-ui-red/80',
                  !canSend && 'opacity-30',
                )}
                onClick={handleInterruptClick}
                disabled={!canSend}
                aria-label={t('interruptAriaLabel')}
              >
                <Square size={14} fill="currentColor" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground',
                  canDispatch && (isTuiAgent ? 'text-foreground' : 'text-claude-active'),
                  !canDispatch && 'opacity-30',
                )}
                onClick={handleSendClick}
                disabled={!canDispatch}
                aria-label={t('sendAriaLabel')}
              >
                {isDispatching ? <Loader2 size={14} className="animate-spin" /> : isDisabled ? <Ban size={14} /> : <SendHorizontal size={16} />}
              </Button>
            )}
            </div>
          </div>
          </div>
        </div>
      </div>

      <InterruptDialog
        open={interruptDialogOpen}
        onOpenChange={setInterruptDialogOpen}
        onConfirm={handleInterruptConfirm}
      />
    </>
  );
};

export default WebInputBar;
