import React, { useState } from 'react';
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function check() {
    setBusy(true);
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
    }
  }
  // Release keeps the pre-save ticket; accept keeps Jira's version of the requested save.
  // Neither writes Jira or cancels a delayed request.
  async function finish(action: 'resolve-save' | 'accept-save', done: string) {
    if (!status?.pending || !status.administrator || status.waitSeconds !== 0 || !acknowledged)
      return;
    if (busy) return;
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
      <Button isDisabled={busy} onClick={() => void check()}>
        Check saved state
      </Button>
      {status?.pending && (
        <>
          <p>The previous save is unresolved. Checking does not repeat the Jira write.</p>
          {!status.administrator ? (
            <p>A Jira administrator with Edit Issues permission must inspect this save.</p>
          ) : status.unchanged ? (
            <>
              <p>
                Jira still has the pre-save Description and prompt field. Releasing this record
                keeps those fields and allows a new reviewed save. It does not cancel a delayed Jira
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
                saved without changing the ticket.
              </p>
              {acknowledgement}
              <Button
                isDisabled={busy || !acknowledged || status.waitSeconds !== 0}
                onClick={() =>
                  void finish(
                    'accept-save',
                    'Saved ticket accepted. Check saved state again if prompts do not reload.',
                  )
                }
              >
                Accept saved ticket
              </Button>
            </>
          ) : (
            <p>
              The ticket differs from both its pre-save state and the requested save. Investigate in
              Jira before making further changes.
            </p>
          )}
        </>
      )}
      <p role="status">{error || notice}</p>
    </div>
  );
}
