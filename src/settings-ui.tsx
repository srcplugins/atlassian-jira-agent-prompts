import React, { useRef, useState } from 'react';
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
export type Health = Awaited<ReturnType<ReturnType<typeof createSettings>['health']>>;
const divider = xcss({ height: '1px', backgroundColor: 'color.background.neutral' });
export function Settings({
  projectId,
  onBusy,
  onUpdated,
  onStale,
  initialHealth,
  configurationAction,
}: {
  projectId: string;
  onBusy?: (busy: boolean) => void;
  onUpdated?: (value: Health) => Promise<void>;
  /** A change was saved but the space could not be read again: the cached check is stale. */
  onStale?: (message: string) => void;
  /** The space's check from the scan that listed it; a later check replaces it. */
  initialHealth: Health;
  configurationAction?: React.ReactNode;
}) {
  const [health, setHealth] = useState<Health | undefined>(initialHealth);
  const context = useProductContext();
  const siteUrl = context?.siteUrl ?? '';
  const [ack, setAck] = useState(false);
  const [refreshAfterSave, setRefreshAfterSave] = useState(
    initialHealth.state.data.refreshAfterSave === true,
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
  /** After a committed change, read the space again. A failed read never relabels the change as
   * failed, and drops the old revision so a second click can't be rejected against it. */
  async function refresh(done: string) {
    let updated: Health;
    try {
      updated = await check();
    } catch {
      const text = `${done} The space could not be checked again; close and reopen its details to refresh.`;
      setHealth(undefined);
      setMessage(text);
      onStale?.(text);
      return;
    }
    await onUpdated?.(updated);
    setMessage(done);
  }
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
                    Prompt work type
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
                {'layouts' in health ? (
                  <Stack space="space.050">
                    <Text size="small" color="color.text.subtle">
                      Agent Prompts on layouts
                    </Text>
                    <Text>
                      {health.layouts
                        .filter((layout) => layout.present)
                        .map((layout) => layout.name)
                        .join(', ') ||
                        // A layout that could not be read is never shown as missing the field.
                        (health.layouts.some((layout) => layout.present === undefined)
                          ? 'Not known'
                          : 'None')}
                    </Text>
                  </Stack>
                ) : (
                  <Stack space="space.050">
                    <Text size="small" color="color.text.subtle">
                      Screens
                    </Text>
                    <Text>
                      {(health.state.data.screenTypes ?? [])
                        .map(
                          (id) =>
                            health.project.issueTypes.find((type) => type.id === id)?.name ??
                            `Work type ID ${id}`,
                        )
                        .join(', ') || 'Not set'}
                    </Text>
                  </Stack>
                )}
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
                        {check.label} — {check.detail}
                      </Text>
                    ))}
                </SectionMessage>
              )}
              {health.state.data.pending ? (
                <SectionMessage appearance="warning" title="Unfinished configuration">
                  <Stack space="space.150">
                    <Text>
                      An earlier change did not finish cleanly. Requested type:{' '}
                      {health.state.data.pending.name ?? health.state.data.pending.type}. It may
                      also have changed screens. Inspect the result before making another change.
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
                      label="I inspected Jira’s type list and the reviewed screens and resolved the earlier operation; do not repeat its writes."
                      isChecked={ack}
                      onChange={(e) => setAck(e.target.checked === true)}
                    />
                    <Inline space="space.100" shouldWrap>
                      <Button
                        isDisabled={busy || !ack}
                        onClick={() =>
                          void run(async () => {
                            await call('settings-resolve', {
                              ...target,
                              revision: health.state.revision,
                            });
                            await refresh(
                              'Resolution acknowledged. Select the existing type and work types for screens, then review the change.',
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
                label="Reload work item after saving prompts"
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
                      await call('settings-preferences', {
                        ...target,
                        revision: health.state.revision,
                        refreshAfterSave,
                      });
                      await refresh('Preferences saved.');
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
              {health.project.teamManaged ? (
                <>
                  <Text color="color.text.subtle">
                    This team-managed space is set up by hand: add Agent Prompts in Fields, place it
                    on the layouts of the work types that use prompts, and create the prompt work
                    type in Work types. The app changes nothing in these settings.
                  </Text>
                  <Inline space="space.200" shouldWrap>
                    <Link
                      openNewTab
                      href={`${siteUrl}/jira/software/projects/${health.project.key}/settings/fields`}
                    >
                      Field settings
                    </Link>
                    <Link
                      openNewTab
                      href={`${siteUrl}/jira/software/projects/${health.project.key}/settings/issuetypes`}
                    >
                      Work type settings
                    </Link>
                  </Inline>
                </>
              ) : (
                <>
                  <Text color="color.text.subtle">
                    Work type scheme: {health.scheme?.name ?? 'Could not be checked'}
                  </Text>
                  <Inline space="space.200" shouldWrap>
                    <Link
                      openNewTab
                      href={`${siteUrl}/plugins/servlet/project-config/${health.project.key}/issuetypes`}
                    >
                      Work type settings
                    </Link>
                    <Link
                      openNewTab
                      href={`${siteUrl}/plugins/servlet/project-config/${health.project.key}/screens`}
                    >
                      Screen settings
                    </Link>
                  </Inline>
                </>
              )}
            </Stack>
          </Box>
        </>
      )}
      {busy && (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" label="Updating space settings" />
          <Text>{health ? 'Updating space settings…' : 'Checking space…'}</Text>
        </Inline>
      )}
      {/* Present from the first render so assistive technology announces each outcome. */}
      <Box role="status">{message && <Text>{message}</Text>}</Box>
    </Stack>
  );
}
