import React, { useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button/new';
import { call } from './client';
import type { SaveStatus } from './service';

export function SaveRecovery({
  onRecovered,
  initialStatus,
}: {
  onRecovered: () => Promise<void>;
  initialStatus?: SaveStatus | undefined;
}) {
  const [status, setStatus] = useState<SaveStatus | undefined>(initialStatus);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Release removes its own button, so focus moves to Check saved state afterwards.
  const checkButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    checkButton.current?.focus();
  }, [busy]);
  async function check() {
    setBusy(true);
    setChecking(true);
    setError('');
    setNotice('');
    setAcknowledged(false);
    try {
      const value = await call<SaveStatus>('save-status');
      setStatus(value);
      if (!value.pending) await onRecovered();
    } catch (e) {
      setStatus(undefined);
      setError(e instanceof Error ? e.message : 'Saved state could not be checked.');
    } finally {
      setBusy(false);
      setChecking(false);
    }
  }
  // Release keeps the last saved selection. It doesn't write Jira or cancel a delayed request.
  async function release() {
    if (!status?.pending || !status.administrator || status.waitSeconds !== 0 || !acknowledged)
      return;
    if (busy) return;
    refocus.current = true;
    setBusy(true);
    setError('');
    try {
      await call('resolve-save', {
        revision: status.revision,
        fingerprint: status.fingerprint,
        acknowledged,
      });
      // The release control disappears even if the following reload fails.
      setStatus(undefined);
      setAcknowledged(false);
      setNotice('Recovery record released. Check saved state again if prompts do not reload.');
      await onRecovered();
    } catch (e) {
      setStatus(undefined);
      setAcknowledged(false);
      setError(
        e instanceof Error ? e.message : 'Recovery could not be confirmed. Check saved state.',
      );
    } finally {
      setBusy(false);
    }
  }
  const waiting = !!status?.waitSeconds;
  const acknowledgement = (
    <>
      {waiting && <p>Wait {status?.waitSeconds} seconds, then check saved state again.</p>}
      <label>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy || status?.waitSeconds !== 0}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I have investigated the previous save in Jira and understand that a delayed request may
        still finish.
      </label>
    </>
  );
  return (
    <div>
      {/* The field's controls are disabled while it is open, so it starts with focus. */}
      <Button
        ref={checkButton}
        autoFocus
        isLoading={checking}
        isDisabled={busy && !checking}
        onClick={() => void check()}
      >
        Check saved state
      </Button>
      {status?.pending && (
        <>
          <p>The previous save is unresolved. Checking does not repeat the Jira write.</p>
          {!status.administrator ? (
            <p>A Jira administrator with Edit work items permission must inspect this save.</p>
          ) : (
            <>
              <p>
                Jira doesn&apos;t show that this save landed. Releasing this record keeps the last
                saved prompts and writes nothing to Jira; Sync then rewrites the Agent Prompts
                section from them. It does not cancel a delayed Jira request.
              </p>
              {status.keys && (
                <p>
                  The save was writing {status.keys.length ? status.keys.join(', ') : 'no prompts'}.
                </p>
              )}
              {acknowledgement}
              <Button
                isDisabled={busy || !acknowledged || status.waitSeconds !== 0}
                onClick={() => void release()}
              >
                Release save
              </Button>
            </>
          )}
        </>
      )}
      <p role="status">{error || notice}</p>
    </div>
  );
}
