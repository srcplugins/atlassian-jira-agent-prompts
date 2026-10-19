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
  // Release and accept remove their own button, so focus moves to Check saved state afterwards.
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
  // Release keeps the pre-save state; accept keeps Jira's version of the requested save.
  // Neither writes Jira or cancels a delayed request.
  async function finish(action: 'resolve-save' | 'accept-save', done: string) {
    if (!status?.pending || !status.administrator || status.waitSeconds !== 0 || !acknowledged)
      return;
    if (busy) return;
    refocus.current = true;
    setBusy(true);
    setError('');
    try {
      await call(action, {
        revision: status.revision,
        fingerprint: status.fingerprint,
        acknowledged,
      });
      // The release control disappears even if the following reload fails.
      setStatus(undefined);
      setAcknowledged(false);
      setNotice(done);
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
          ) : status.unchanged ? (
            <>
              <p>
                Jira still has the pre-save prompt field and Agent Prompts block. Releasing this
                record keeps them and allows a new reviewed save. It does not cancel a delayed Jira
                request.
              </p>
              {acknowledgement}
              <Button
                isDisabled={busy || !acknowledged || status.waitSeconds !== 0}
                onClick={() =>
                  void finish(
                    'resolve-save',
                    'Recovery record released. Check saved state again if prompts do not reload.',
                  )
                }
              >
                Release unchanged save
              </Button>
            </>
          ) : status.adoptable ? (
            <>
              <p>
                Jira holds the requested save ({status.keys?.join(', ') || 'no prompts'}) with its
                text and structure intact, in a slightly different format. Accepting records it as
                saved without changing the work item.
              </p>
              {acknowledgement}
              <Button
                isDisabled={busy || !acknowledged || status.waitSeconds !== 0}
                onClick={() =>
                  void finish(
                    'accept-save',
                    'Saved work item accepted. Check saved state again if prompts do not reload.',
                  )
                }
              >
                Accept saved work item
              </Button>
            </>
          ) : status.sectionRemoved ? (
            <>
              <p>
                The Agent Prompts section is no longer in the description, so this save’s outcome
                can’t be proven. Releasing this record keeps the work item as it is now, writes
                nothing to Jira and allows a new reviewed save. It does not cancel a delayed Jira
                request.
              </p>
              {acknowledgement}
              <Button
                isDisabled={busy || !acknowledged || status.waitSeconds !== 0}
                onClick={() =>
                  void finish(
                    'resolve-save',
                    'Recovery record released. Check saved state again if prompts do not reload.',
                  )
                }
              >
                Release save
              </Button>
            </>
          ) : (
            <p>
              The work item differs from both its pre-save state and the requested save. To release
              this save, delete the Agent Prompts section from the description in Jira, then check
              saved state again.
            </p>
          )}
        </>
      )}
      <p role="status">{error || notice}</p>
    </div>
  );
}
