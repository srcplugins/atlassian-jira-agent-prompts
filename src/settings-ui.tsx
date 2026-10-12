import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  xcss,
  useProductContext,
  Lozenge,
  SectionMessage,
  Button,
  Inline,
  Checkbox,
  Heading,
  Link,
  Spinner,
  Stack,
  Text,
} from '@forge/react';
import { call } from './client';
import { createLatch } from './shared/latch.mjs';
import type { createSettings } from './settings';
type Health = Awaited<ReturnType<ReturnType<typeof createSettings>['health']>>;
const divider = xcss({ height: '1px', backgroundColor: 'color.background.neutral' });
// Health payloads are also consumed outside this page; adapt terminology here.
const issueCopy = (text: string) =>
  text
    .replace(/Ticket/g, 'Issue')
    .replace(/ticket/g, 'issue')
    .replace('Select it below', 'Use Reconfigure project');
export function Settings({
  projectId,
  onBusy,
  onChange,
  onUpdated,
  initialHealth,
  configurationAction,
}: {
  projectId: string;
  onBusy?: (busy: boolean) => void;
  onChange?: () => void;
  onUpdated?: (value: Health) => Promise<void>;
  initialHealth?: Health;
  configurationAction?: React.ReactNode;
}) {
  const [health, setHealth] = useState<Health | undefined>(initialHealth);
  const context = useProductContext();
  const siteUrl = context?.siteUrl ?? '';
  const [ack, setAck] = useState(false);
  const [refreshAfterSave, setRefreshAfterSave] = useState(
    initialHealth?.state.data.refreshAfterSave === true,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const target = { projectId };
  // UI Kit can deliver a second click before the disabled tree reaches the host.
  const latch = useRef(createLatch()).current;
  function run(action: () => Promise<unknown>) {
    return latch.run(async () => {
      setBusy(true);
      onBusy?.(true);
      setMessage('');
      try {
        await action();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : 'Check or change failed.');
      } finally {
        setBusy(false);
        onBusy?.(false);
      }
    });
  }
  async function check() {
    const value = await call<Health>('settings-health', target);
    setHealth(value);
    setRefreshAfterSave(value.state.data.refreshAfterSave === true);
    setAck(false);
    return value;
  }
  useEffect(() => {
    if (!initialHealth) void run(check);
    // The parent keys this editor by project, so it is seeded once.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Seed once from the scan (or load on entry); later scan invalidation must not reload over an active repair.
  }, []);
  return (
    <Stack space="space.150">
      {health && (
        <>
          <Box xcss={divider} role="separator" />
          <Box paddingBlockStart="space.100">
            <Stack space="space.200">
              <Inline space="space.150" alignBlock="center" shouldWrap>
                <Heading as="h3" size="small">
                  Configuration
                </Heading>
                <Lozenge
                  appearance={
                    health.state.data.pending || health.checks.some((check) => !check.ok)
                      ? 'moved'
                      : health.state.data.type
                        ? 'success'
                        : 'default'
                  }
                >
                  {health.state.data.pending
                    ? 'Needs attention'
                    : !health.state.data.type
                      ? 'Not configured'
                      : health.checks.every((check) => check.ok)
                        ? 'Healthy'
                        : 'Needs attention'}
                </Lozenge>
              </Inline>
              <Inline space="space.600" rowSpace="space.150" shouldWrap>
                <Stack space="space.050">
                  <Text size="small" color="color.text.subtle">
                    Prompt issue type
                  </Text>
                  <Text>
                    {health.types.find((type) => type.id === health.state.data.type)?.name ??
                      (health.state.data.type ? 'Unavailable' : 'Not configured')}
                  </Text>
                </Stack>
                <Stack space="space.050">
                  <Text size="small" color="color.text.subtle">
                    Custom field
                  </Text>
                  <Text>Agent Prompts</Text>
                </Stack>
              </Inline>
              <Inline space="space.200" alignBlock="center" shouldWrap>
                {configurationAction}
              </Inline>
              {health.checks.some((check) => !check.ok) && (
                <SectionMessage appearance="warning" title="Review configuration">
                  {health.checks
                    .filter((check) => !check.ok)
                    .map((check) => (
                      <Text key={check.label}>
                        {issueCopy(check.label)} — {issueCopy(check.detail)}
                      </Text>
                    ))}
                </SectionMessage>
              )}
              {health.state.data.pending ? (
                <SectionMessage appearance="warning" title="Unfinished configuration">
                  <Stack space="space.150">
                    <Text>
                      An earlier change did not finish cleanly. Requested type:{' '}
                      {health.state.data.pending.name ?? health.state.data.pending.type}. Inspect
                      the result before making another change.
                    </Text>
                    <Inline space="space.100" shouldWrap>
                      <Button
                        isDisabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await call<{ message: string }>(
                              'settings-recover',
                              target,
                            );
                            setMessage(result.message);
                          })
                        }
                      >
                        Check outcome
                      </Button>
                    </Inline>
                    <Checkbox
                      isDisabled={busy}
                      label="I inspected Jira’s type list and resolved the earlier operation; do not repeat its writes."
                      isChecked={ack}
                      onChange={(e) => setAck(e.target.checked === true)}
                    />
                    <Inline space="space.100" shouldWrap>
                      <Button
                        isDisabled={busy || !ack}
                        onClick={() =>
                          void run(async () => {
                            onChange?.();
                            await call('settings-resolve', {
                              ...target,
                              revision: health.state.revision,
                            });
                            const updated = await check();
                            await onUpdated?.(updated);
                            setMessage(
                              'Resolution acknowledged. Select the existing type and review the mapping.',
                            );
                          })
                        }
                      >
                        Acknowledge resolution
                      </Button>
                    </Inline>
                  </Stack>
                </SectionMessage>
              ) : null}
            </Stack>
          </Box>
          <Box xcss={divider} role="separator" />
          <Box paddingBlockStart="space.100">
            <Stack space="space.150">
              <Heading as="h3" size="small">
                Preferences
              </Heading>
              <Checkbox
                label="Reload ticket after saving prompts"
                isChecked={refreshAfterSave}
                isDisabled={busy || !!health.state.data.pending}
                onChange={(event) => setRefreshAfterSave(event.target.checked === true)}
              />
              <Inline space="space.100" shouldWrap>
                <Button
                  isDisabled={
                    busy ||
                    !!health.state.data.pending ||
                    refreshAfterSave === (health.state.data.refreshAfterSave === true)
                  }
                  onClick={() =>
                    void run(async () => {
                      onChange?.();
                      await call('settings-preferences', {
                        ...target,
                        revision: health.state.revision,
                        refreshAfterSave,
                      });
                      const updated = await check();
                      await onUpdated?.(updated);
                      setMessage('Linking preferences saved.');
                    })
                  }
                >
                  Save
                </Button>
              </Inline>
            </Stack>
          </Box>
          <Box xcss={divider} role="separator" />
          <Box paddingBlockStart="space.100">
            <Stack space="space.150">
              <Heading as="h3" size="small">
                Jira configuration
              </Heading>
              <Text color="color.text.subtle">
                Issue type scheme: {health.scheme?.name ?? 'Could not be checked'}
              </Text>
              <Inline space="space.200" shouldWrap>
                <Link
                  openNewTab
                  href={`${siteUrl}/plugins/servlet/project-config/${health.project.key}/issuetypes`}
                >
                  Issue type settings
                </Link>
                <Link
                  openNewTab
                  href={`${siteUrl}/plugins/servlet/project-config/${health.project.key}/screens`}
                >
                  Screen settings
                </Link>
              </Inline>
            </Stack>
          </Box>
        </>
      )}
      {busy && (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" label="Updating project settings" />
          <Text>{health ? 'Updating project settings…' : 'Checking project…'}</Text>
        </Inline>
      )}
      {/* Present from the first render so assistive technology announces each outcome. */}
      <Box role="status">{message && <Text>{issueCopy(message)}</Text>}</Box>
    </Stack>
  );
}
