import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  Inline,
  List,
  ListItem,
  Heading,
  Label,
  Link,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { call } from './client';
import { CreateIssueModal } from '@forge/jira-bridge';
import { Configuration } from './configuration';
import { promptSearchUrl } from './navigation';
import { usePromptSearch } from './prompt-search';
interface Setup {
  project: {
    id: string;
    key: string;
    issueTypes: { id: string; name: string; subtask: boolean }[];
  };
  type?: string;
}
function App() {
  const [setup, setSetup] = useState<Setup>();
  const [settings, setSettings] = useState(false);
  const search = usePromptSearch('library');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  useEffect(() => {
    call<Setup>('setup').then(
      (value) => {
        setSetup(value);
      },
      (e) => setMessage(e.message),
    );
  }, []);
  function load() {
    search.refresh();
  }
  async function createPrompt(projectId: string, issueTypeId: string) {
    setBusy(true);
    try {
      await new CreateIssueModal({
        context: { projectId, issueTypeId },
        onClose: ({ payload }) => {
          if (payload.length) void load();
        },
      }).open();
    } catch {
      setMessage(
        'Could not open Jira Create. Use Jira’s Create button and select this project and its configured prompt type.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack space="space.150">
      {!settings && (
        <>
          <Heading as="h2">Prompt Library</Heading>
          <Text>
            Prompts are Jira tickets. Save copies their instructions into another ticket’s
            Description. Use Sync on that ticket when you want the latest instructions.
          </Text>
        </>
      )}
      <Inline space="space.100" shouldWrap>
        <Button
          isDisabled={configBusy}
          onClick={() => {
            if (settings)
              call<Setup>('setup').then(
                (value) => {
                  setSetup(value);
                  search.reset({ prompts: [], incomplete: false });
                },
                (e) => setMessage(e.message),
              );
            setSettings(!settings);
          }}
        >
          {settings ? 'Back to library' : 'Project configuration'}
        </Button>
      </Inline>
      {settings && setup && <Configuration projectId={setup.project.id} onBusy={setConfigBusy} />}
      {!settings && setup && !setup.type && (
        <Text>
          Open Project configuration to choose or create your ticket type, then reopen the library.
        </Text>
      )}
      {!settings && setup?.type && (
        <>
          <Heading as="h3" size="small">
            Create a prompt
          </Heading>
          <List type="ordered">
            <ListItem>
              Create a Prompt ticket. Summary is its name; Description is its instructions.
            </ListItem>
            <ListItem>
              On a work ticket, select up to five prompts in Agent Prompts and choose Save.
            </ListItem>
            <ListItem>
              Use Sync to update saved instructions after editing a source prompt.
            </ListItem>
          </List>
          <Text>
            Use text, headings, lists, quotes, code, links and basic text styles, up to 4,000 text
            characters per prompt. Copies are visible to everyone who can read the destination
            ticket, and stay there if the source is later restricted or deleted.
          </Text>
          <Inline space="space.100" shouldWrap>
            <Link openNewTab href={promptSearchUrl(setup.project.id, setup.type)}>
              View in Jira
            </Link>
            <Button
              isDisabled={busy}
              onClick={() => {
                if (setup.type) void createPrompt(setup.project.id, setup.type);
              }}
            >
              Create a prompt ticket
            </Button>
          </Inline>
          <Inline>
            <Button isDisabled={busy} onClick={load}>
              Load prompts
            </Button>
          </Inline>
          <Label labelFor="prompt-search">Search prompts</Label>
          <Textfield
            id="prompt-search"
            value={search.query}
            maxLength={200}
            placeholder="Search by name or ticket key…"
            onChange={(e) => search.change(e.target.value)}
          />
          {search.items.map((p) => (
            <Link key={p.id} href={`/browse/${p.key}`}>
              {p.key} — {p.name}
            </Link>
          ))}
          {search.busy && <Text>Searching…</Text>}
          {search.loaded && !search.busy && !search.error && !search.items.length && (
            <Text>No matching prompts</Text>
          )}
          {search.error && (
            <>
              <Text>{search.error}</Text>
              <Button
                onClick={search.nextCursor ? search.more : search.refresh}
                isDisabled={search.busy}
              >
                Retry search
              </Button>
            </>
          )}
          {search.nextCursor && (
            <Button isDisabled={search.busy} onClick={() => void search.more()}>
              Load more
            </Button>
          )}
        </>
      )}
      {message && <Text>{message}</Text>}
    </Stack>
  );
}
ForgeReconciler.render(<App />);
