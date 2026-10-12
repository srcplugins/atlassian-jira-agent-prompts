# Agent Prompts for Jira

Keep reusable coding standards, review checklists and instructions in Jira issues. Select prompts on a work issue to copy their instructions into its Description, then sync updates when needed. Ask Rovo to find a prompt or read its instructions back to you.

**In development:** supports company-managed Jira Software projects in Jira Cloud. It is not yet on the Atlassian Marketplace, and there is no public installation.

## Usage

### Configure a project

A Jira administrator completes setup once for each project:

1. Open **Apps → Agent Prompts for Jira → Project configuration**, or **Configure / Get started** in Manage apps.
2. Select projects and choose **Configure selected**. Choose an existing base-level global issue type or create a new one. Epic and subtask types are not supported.
3. Choose whether to **Reload ticket after saving prompts** for the selected projects. This is off by default; reloading can discard other unsaved Jira edits.
4. Choose **Review changes**, then **Apply changes**. Resolve or exclude blocked projects and review again before applying.
5. Add the **Agent Prompts** field to the work-issue screens where it should be available.

Installation alone creates no issue types. A new type is created once and reused across the reviewed projects. Prompt sources stay within their own project; new projects need separate setup. The project list includes up to 200 supported projects and warns if incomplete. Select all applies only to matching listed projects.

Shared issue type schemes can affect projects outside your selection. Review and acknowledge the listed impact before applying. Default schemes, screens, workflows and board layouts require Jira administration; the app does not configure them automatically.

**Keep prompts off boards and screens.** Prompt tickets are ordinary Jira issues: until a Jira administrator adjusts the project, they appear on boards and offer every field and transition of the project's normal configuration. For a minimal prompt form, give the prompt type a dedicated screen with only Summary and Description, a one-status workflow (for example **Prompt available**), and leave that status unmapped on each board. These are native Jira administration changes; the app neither makes nor checks them.

### Create and use prompts

1. Create an issue using the project's configured prompt type. **Summary** is the prompt's name; **Description** contains its instructions. You can also use **Create a prompt ticket** in the Prompt Library, the app's project page (**Apps → Agent Prompts for Jira** in the project sidebar).
2. On a work issue, edit **Agent Prompts** and select up to five prompts from the same project.
3. Click **Save**. The instructions are copied into one **Agent Prompts** expander in Description.
4. After changing a source prompt, click **Sync** on a linked issue to copy the latest instructions for its saved selection. Save or discard unsaved choices first.

Source edits do not update existing copies automatically. Remove a selection and Save to remove its copied instructions. Without the reload preference, reopen or reload the issue to see Description changes. An issue of the configured prompt type cannot add other prompts, but existing links can still be removed.

Prompts must contain 1–4,000 text characters. Text, headings, lists, quotes, code, links (http, https or mailto) and basic text styles are copied; inline comment anchors are left out. Embedded cards, media and other formatting are rejected with a message naming the problem.

### Find a prompt

The field loads when edited and initially shows the ten newest visible prompts. Type a name or exact issue key in the dropdown; **Load more** retrieves additional matches, ten at a time. Clearing search restores the initial suggestions. Selected prompts remain available as you search. If suggestions fail to load, saved selections stay available for removal; use **Retry search** to find other prompts. If previous-type details or the reload preference cannot be checked, saved selections remain removable; reload the ticket manually when the preference is unavailable.

In the Prompt Library, choose **Load prompts** or type in **Search prompts**; it shows twenty matches per page and offers **View in Jira** to open a project/type search. A name search matches prompts containing every entered word, as typed, as a word start or in another form of the word ("tests" finds "test"); common words such as "the" and "and" are ignored. Jira indexing and your permissions affect results; a newly created prompt may not appear immediately. An exact key that does not exist or that you cannot see shows no match. Once five prompts are selected, remove one to add another.

### Ask Rovo about prompts

Agent Prompts adds two read-only agents to Rovo, Jira's AI assistant. Open Rovo Chat, browse agents and choose one.

**Agent Prompts Assistant** finds a project's prompts by name and reads their instructions back to you. For example:

- “Find review prompts in project TEAM.”
- “Which prompts in TEAM are about error handling?”
- “Read prompt TEAM-42.”
- “Show me the full instructions in TEAM-42 so I can paste them into my coding agent.”

Search matches prompt names and returns up to twenty matches; refine the query for more. Reads keep list numbering and nesting, quoted text and code blocks. Source text is limited to 4,000 characters and the formatted response to 16,000. Rich content that cannot safely become plain text, including links and struck-out instructions, must be read in Jira.

**Ticket Description Summary** summarizes the Description of the issue you're on. For example:

- “Summarize this ticket's description.”
- “Summarize the description of TEAM-108.”

It reads that issue only, without following linked sources; responses over 60 KB are rejected.

See [Rovo control](#rovo-control) for what the agents can access.

## Configuration and repair

Use **Check selected** to check selected projects, or **View details** to open one project's status and preferences. Opening details or Configure reuses successful checks from the current visit; missing or failed checks are requested as needed. Refreshing clears cached results. Explicit Check selected runs a fresh check.

In details, use **Reconfigure project** to review a different type or repair a missing association. **Jira configuration** links open issue type and screen settings in new tabs. Change the reload preference under **Preferences**, then **Save**. Cancelling a configuration review preserves your selection and checked results. **Project settings → Agent Prompts for Jira** leads to the same view.

To disconnect projects, select them and choose **Configure selected → Prompt issue type → Unlink selected projects**, then review and apply. This clears app mappings and preferences. It does not delete issues, prompt links, copied descriptions or Jira issue types. Configure again to resume use. Changing a type does not migrate existing issues; previously linked sources remain usable or removable, but are not offered as new selections. Each project keeps up to 20 previous type identities; after that, another type replacement is blocked until an administrator reviews existing links.

### Interrupted configuration

Reloading or reopening Project configuration cancels your unfinished batch, including when you open it in another tab. Completed changes stay in place. Another administrator's batch is not cancelled automatically. An in-flight request may take up to two minutes to release the batch; cancellation cannot undo or stop a delayed Jira write.

If Jira rejected a step before changing anything (for example, a type with that name already exists), or a project changed after review, the batch stops with that reason and no outcome check; completed projects stay configured, so review the remaining projects again. If the outcome is uncertain, use **Check affected project** and inspect Jira before acknowledging resolution. In an open configuration dialog, **Check saved progress** checks the saved outcome without repeating a write. Reuse any issue type already created when configuring unfinished projects. Avoid changing the same schemes directly in Jira while configuration is running.

If another administrator has abandoned a batch, including one left cancelling, choose **Review saved configuration**, inspect its results and any affected Jira changes, then acknowledge that inspection and choose **Release abandoned batch**. Releasing another administrator's batch always needs that acknowledgement; an uncertain or in-flight step also requires a two-minute wait. This releases the batch without continuing its writes; completed changes and project recovery records remain. If type discovery fails, saved progress and **Unlink selected projects** remain available; creating or selecting a type requires a successful type check.

### Save or sync problems

- **A prompt is missing:** check its project, configured issue type, visibility and Jira search indexing. Search by exact key. Deleted, moved or inaccessible selected sources block saves.
- **A save fails:** the app checks saved state once while preserving your draft selection and search; it does not repeat the write. Correct the reported problem and retry, or choose **Discard changes**. If Jira is limiting requests, nothing was saved; wait a moment and save again. If the outcome remains uncertain, use **Check saved state**.
- **The field does not load:** the message names the cause (for example, a project that is not configured, or the field missing from the screen). Fix it and choose **Try again**.
- **The copied block was edited or duplicated:** the app stops rather than overwriting content it cannot identify safely. Resolve the reported conflict before continuing; a matching expander title does not establish ownership.
- **The copied block was deleted in Jira:** remove all prompts and **Save**. This clears only the Agent Prompts field and leaves Description untouched; add prompts again afterwards.

Save only after finishing other Description edits. The app detects stale state, but a simultaneous native Jira edit can still race its final write. If Jira confirms a save but stores the block in a slightly different format, the app accepts it when the field and the block's text and structure match exactly. Other unresolved write outcomes require administrator review.

For an unresolved save, a Jira administrator with Edit Issues permission can use **Check saved state**. If Jira still has the exact pre-save Description and field, wait at least two minutes, investigate the previous operation in Jira, acknowledge the result and choose **Release unchanged save**. If Jira instead holds the requested save (the same prompts in the field and the same block text and structure) in a different format, choose **Accept saved ticket** after the same wait and acknowledgement. Older records start the wait on the first administrator check. Both change only the app's recovery record and reload the picker with existing draft choices preserved; neither undoes or cancels a delayed Jira request. Any other outcome remains blocked for investigation. Saves that never reached submission are recovered without repeating a Jira write.

## Permissions

| Scope | Purpose |
| --- | --- |
| `read:jira-work` | Find visible prompts and read source/destination issues and field identity. |
| `write:jira-work` | Save the destination Description and Agent Prompts field as the current user. |
| `manage:jira-configuration` | Inspect issue type schemes and create or attach types after administrator review. |
| `storage:app` | Store project configuration and tracking/recovery records. |

Reads and writes run as you. Browse Projects and issue security control visibility; saving requires Edit Issues, creating prompts requires Create Issues, and configuration/project-health checks require Administer Jira. Ordinary prompt use and checking a saved issue outcome do not require administrator permissions. Releasing an unresolved, unchanged save or accepting a saved ticket requires both Administer Jira and Edit Issues.

## Data

Jira stores source instructions and destination copies. **Anyone who can read a destination issue can read its copied instructions.** Restricting or deleting a source later does not remove existing copies. Check destination access before copying sensitive content.

Forge stores settings, active/previous type IDs, ordered source IDs, content fingerprints and recovery metadata, including the latest configuration batch's administrator and reviewed projects. It does not store a separate prompt-body catalog. The app declares no external network egress and does not log prompt content. Rovo processing is described separately below.

Native Jira issues, history and copied instructions remain after uninstall. Forge retains app data for 28 days; reinstalling does not automatically restore it. See [Forge storage recovery](https://developer.atlassian.com/platform/forge/storage-reference/#data-recovery-for-apps-with-hosted-storage). A new installation cannot automatically adopt untracked Description blocks.

## Rovo control

The agents appear only where Rovo is available on your Jira site. Neither agent changes issues or runs a coding agent. Both read as you, so Jira visibility applies; Agent Prompts Assistant searches only the configured prompt type of a company-managed Software project. Requests and returned content are processed by Rovo under [Atlassian's Rovo data policies](https://support.atlassian.com/rovo/docs/rovo-data-privacy-and-usage-guidelines/), including possible third-party model processing. Rovo processing and retention are separate from app-owned Forge storage.

## Development

Requires Node.js 24 (see `.nvmrc`). Run `npm ci`, then `npm run check` for formatting, linting, type checks, the Custom UI build, tests, the manifest, README and built-bundle checks, and the production license inventory. Files marked “Managed by srcplugins/dev-platform” are synchronized from the shared platform repository; change them there. Deployment and hosted acceptance run from that platform with owned test sites.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE.md). Third-party production dependencies are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
