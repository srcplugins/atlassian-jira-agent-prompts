# Agent Prompts for Jira

**Reusable instructions for your coding agents.**

Stop repeating the same instructions across Jira work items. Create reusable prompts for coding standards, review guidelines and team conventions, all managed directly in Jira. Add the right prompts to each work item to give your coding agents the context they need.

[Watch the demo](https://youtu.be/bzba00JMcGI) · [Website](https://srcplugins.com/plugins/atlassian/agent-prompts-for-jira/)

## Features

- **Manage prompts directly in Jira.** Create reusable prompts as ordinary Jira work items, using Jira's editor, permissions and history.
- **Give every work item the right context.** Add prompts to work items, with their instructions saved directly in the description.
- **Update instructions.** Sync changes to work items after editing a prompt.
- **Retire prompts.** Move a prompt to any status in Jira's Done category and the field and the Rovo assistant stop suggesting it; work items that use it keep it. Don't use a Done-category status to mean approved.
- **Ask Rovo.** Find prompts and read their instructions with the read-only Agent Prompts Assistant.

Agent Prompts works in company-managed and team-managed software spaces (team-managed spaces require manual configuration).

Jira doesn't let apps change a team-managed space's settings, so a space admin adds the Agent Prompts field to the space and to the layouts of the work types that use prompts, and creates the prompt work type, in **Space settings**. A Jira administrator then chooses that work type in **Configure**, and the space's details show which work types have the field.

For installation, configuration, usage and troubleshooting, see the [website documentation](https://srcplugins.com/plugins/atlassian/agent-prompts-for-jira/).

## Changes to Jira

- **On install:** adds the Agent Prompts field and the read-only Agent Prompts Assistant to Rovo. No spaces, screens or work types change.
- **When an administrator sets up a company-managed space,** after reviewing and approving each change: creates a prompt work type or reuses an existing one and adds it to the space's work type scheme, adds the Agent Prompts field to the edit and view screens of the work types they choose, and adds summary and description to the prompt type's create screen where they're missing. Adding a field to a screen lets Jira also update the field configuration so the field shows. Work types are site-wide, and shared schemes and screens also affect other spaces; the review lists them before anything changes. A screen may also be used on workflow transitions, which the review can't list.
- **When an administrator sets up a team-managed space,** nothing changes in Jira: the app stores which of the space's own work types holds prompts.
- **In everyday use:** **Save** and **Sync** edit the work item's description and Agent Prompts field as the current user.
- **Removing setup** clears the app's settings and removes the field from the screens the app added it to, except screens another set-up space still uses with the field. Work types, scheme changes, field configuration, layouts, prompts and copied instructions stay. When one removal covers every space that shares such a screen, it stops at the last of them, which would now take the field off that screen; review that space again to approve it.
- **Limits:** one review covers up to 50 screens per space; when one request cannot make all of a space's screen changes, **Apply changes** continues with the rest in further steps of the same run. A screen used by more than 1,000 spaces is changed in Jira settings instead.
- The app never changes workflows, boards or permission schemes, and never deletes work items or work types.

## Permissions

Everything runs as the current user, so Jira's normal visibility rules apply. Saving needs **Edit work items**, creating prompts needs **Create work items** and setup needs **Administer Jira**. A space's health checks also need **Create work items** in that space: to check the prompt type's create fields, and in a team-managed space to show which layouts have the field. Resolving an unconfirmed save as an administrator needs both **Administer Jira** and **Edit work items**.

| Scope                       | Purpose                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `read:jira-work`            | Find visible prompts and read the source and destination work items.                                                                           |
| `write:jira-work`           | Save the destination description and Agent Prompts field as the current user.                                                                  |
| `manage:jira-configuration` | Inspect work type schemes and create or attach a prompt type after administrator review.                                                       |
| `manage:jira-project`       | Read screens and screen schemes, add or remove the Agent Prompts field, and add summary and description to screens after administrator review. |
| `storage:app`               | Store space configuration, records of screens the app changed and save-recovery records.                                                       |

## Data

Prompts and their copied instructions stay in Jira. Atlassian Forge stores the app's configuration, save-recovery data, each work item's selected prompt IDs and content fingerprints, a record of the latest space configuration (including the administrator who ran it) and which screens the app added the Agent Prompts field to; removing setup removes the field only from those screens. The app does not send data outside Atlassian or log prompt content. After uninstalling, work items and copies remain; Forge keeps app data for 28 days, and reinstalling doesn't restore it automatically.

**Note:** Copied instructions follow the destination work item's permissions, even if the original prompt is later restricted or deleted. Rovo features are subject to [Atlassian's Rovo data policies](https://support.atlassian.com/rovo/docs/rovo-data-privacy-and-usage-guidelines/), which may include third-party models.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

Third-party components and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
