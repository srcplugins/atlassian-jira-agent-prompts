import { activeTarget, safeRequest } from '@srcplugins/atlassian-forge-test-framework/core';

/**
 * The URL of a fixture space's one board, read from Jira Software's REST API (the framework's
 * client reads only the platform API). `project` is `owned.project`; team-managed boards live
 * under /jira/software/projects, company-managed ones under /jira/software/c/projects.
 */
export async function spaceBoard(request, project) {
  const site = activeTarget().site;
  const response = await safeRequest(
    () =>
      request.get(`${site}/rest/agile/1.0/board?projectKeyOrId=${project.id}`, {
        timeout: 30000,
        maxRedirects: 0,
      }),
    'GET board',
  );
  if (!response.ok()) throw Error(`Board lookup failed (HTTP ${response.status()})`);
  const boards = (await response.json()).values ?? [];
  if (boards.length !== 1) throw Error(`Expected one board in the space, found ${boards.length}`);
  const prefix = project.style === 'next-gen' ? 'projects' : 'c/projects';
  return `${site}/jira/software/${prefix}/${project.key}/boards/${boards[0].id}`;
}
