﻿//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/*eslint no-console: ["error", { allow: ["warn"] }] */

import fs from 'fs';
import path from 'path';

import recursiveReadDirectory from 'recursive-readdir';

import { wrapError, sleep, asNumber } from '../../utils';
import { Organization } from '../../business/organization';
import { Operations } from '../../business/operations';
import { RepositoryMetadataEntity, GitHubRepositoryVisibility, GitHubRepositoryPermission, GitHubRepositoryPermissions } from '../../entities/repositoryMetadata/repositoryMetadata';
import { Repository } from '../../business/repository';

export interface IApprovalPackage {
  id: string;
  // requestingUser: string;
  repositoryMetadata: RepositoryMetadataEntity;
  createResponse: unknown;
}

export enum RepoWorkflowDecision {
  Approve = 'approve',
  Deny = 'deny',
}

export interface IRepositoryWorkflowOutput {
  error?: any;
  message?: string;
}

export class RepoWorkflowEngine {
  organization: Organization;
  request: RepositoryMetadataEntity;
  user: string;
  id: string;
  typeName: string;
  private createResponse?: unknown;

  constructor(organization: Organization, approvalPackage: IApprovalPackage) {
    this.request = approvalPackage.repositoryMetadata;
    // this.user = approvalPackage.requestingUser;
    this.id = approvalPackage.id;
    this.organization = organization;
    this.typeName = 'Repository Create';
    this.createResponse = approvalPackage.createResponse;
  }

  editGet(req, res) {
    req.individualContext.webContext.render({
      view: 'org/team/approvals/editRepo',
      title: 'Edit Repo Request',
      state: {
        entry: this.request,
        teamUrl: req.teamUrl,
        team: req.team,
      },
    });
  }

  editPost(req, res, next) {
    const { operations } = this.organization.getLegacySystemObjects();
    const repositoryMetadataProvider = operations.providers.repositoryMetadataProvider;
    const visibility = req.body.repoVisibility;
    if (!(visibility == 'public' || visibility == 'private')) {
      return next(new Error('Visibility for the repo request must be provided.'));
    }
    this.request.repositoryName = req.body.repoName;
    this.request.initialRepositoryVisibility = visibility === 'public' ? GitHubRepositoryVisibility.Public : GitHubRepositoryVisibility.Private;
    this.request.initialRepositoryDescription = req.body.repoDescription;
    // this ... repoUrl = req.body.repoUrl
    repositoryMetadataProvider.updateRepositoryMetadata(this.request).then(ok => {
      return res.redirect(req.teamUrl + 'approvals/' + this.id);
    }).catch(error => {
      return next(wrapError(error, 'There was a problem updating the request.'));
    });
  }

  getApprovedViewName() {
    return 'org/team/repos/repoCreated';
  }

  getDecisionEmailViewName() {
    return 'repoApprovals/decision';
  }

  async executeNewRepositoryChores(): Promise<IRepositoryWorkflowOutput[] /* output */> {
    const request = this.request;
    const output = [];
    const organization = this.organization;
    const repoName = request.repositoryName;
    for (let i = 0; i < request.initialTeamPermissions.length; i++) {
      let { teamId, permission, teamName } = request.initialTeamPermissions[i];
      if (teamId && !teamName) {
        try {
          const team = organization.team(asNumber(teamId));
          await team.getDetails();
          if (team.name) {
            teamName = team.name;
          }
        } catch (noFail) { /* ignore */ }
      }
      if (teamId && permission) {
        output.push(await addTeamPermission(organization, repoName, asNumber(teamId), teamName, permission));
      }
    }
    if (request.initialTemplate) {
      try {
        output.push(await createAddTemplateFilesTask(organization, repoName, request.initialTemplate));
        output.push(await addTemplateWebHook(organization, repoName, request.initialTemplate));
        output.push(await addTemplateCollaborators(organization, repoName, request.initialTemplate));
      } catch (outerError) {
        // ignored
        console.dir(outerError);
      }
    }
    // GitHub adds the creator of a repo as an admin directly now, but we don't need that...
    output.push(await removeOrganizationCollaboratorTask(organization, this.createResponse));
    return output.filter(real => real);
  }
}

async function addTeamPermission(organization: Organization, repoName: string, id: number, teamName: string, permission: GitHubRepositoryPermission): Promise<IRepositoryWorkflowOutput> {
  let attempts = 0;
  const calculateDelay = (retryCount: number) => 500 * Math.pow(2, retryCount);
  let error = null;
  const teamIdentity = teamName ? `${teamName} (${id})` : `with the ID ${id}`;
  while (attempts < 3) {
    try {
      const ok = await organization.repository(repoName).setTeamPermission(id, permission);
      return { message: `Successfully added the ${repoName} repo to GitHub team ${teamIdentity} with ${permission.toUpperCase()} permissions.` };
    } catch (iterationError) {
      error = iterationError;
    }
    const nextInterval = calculateDelay(attempts++);
    await sleep(nextInterval);
  };
  const message = `The addition of the repo ${repoName} to GitHub team ${teamIdentity} failed. GitHub returned an error: ${error.message}.`;
  return { error, message };
};

async function getFileContents(templateRoot:string, templatePath: string, templateName: string, absoluteFileNames: string[]): Promise<IFileContents[]> {
  const contents = [];
  for (let i = 0; i < absoluteFileNames.length; i++) {
    const absoluteFileName = absoluteFileNames[i];
    const fileName = path.relative(templateRoot, absoluteFileName);
    const fileContents = await readFileToBase64(templatePath, templateName, fileName);
    contents.push(fileContents);
  }
  return contents;
}

interface IFileContents {
  path: string;
  content: string; // base 64 content
}

async function getTemplateFilenames(templateRoot: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    recursiveReadDirectory(templateRoot, (error, fileNames: string[]) => {
      return error ? reject(error) : resolve(fileNames);
    });
  });
}

async function readFileToBase64(templatePath: string, templateName: string, fileName: string): Promise<IFileContents> {
  return new Promise((resolve, reject) => {
    fs.readFile(path.join(templatePath, templateName, fileName), (error, file) => {
      if (error) {
        return reject(error);
      }
      const base64content = file.toString('base64');
      return resolve({
        path: fileName,
        content: base64content,
      });
    });
  });
}

async function addTemplateWebHook(organization: Organization, repositoryName: string, templateName: string): Promise<IRepositoryWorkflowOutput> {
  const { operations } = organization.getLegacySystemObjects();
  const config = operations.config;
  const definitions = config.github.templates.definitions;
  const templateData = definitions ? definitions[templateName] : null;
  if (!templateData || ! templateData.webhook) {
    return null;
  }
  const repository = organization.repository(repositoryName);
  const webhook = templateData.webhook;
  const webhookSharedSecret = templateData.webhookSharedSecret;
  const webhookEvents = templateData.webhookEvents;
  const webhookFriendlyName = templateData.webhookFriendlyName;
  let error = null;
  let message = null;
  const friendlyName = webhookFriendlyName || webhook;
  try {
    const webhookConnected = await repository.createWebhook({
      config: {
        url: webhook,
        content_type: 'json',
        secret: webhookSharedSecret,
        insecure_ssl: '0',
      },
      events: webhookEvents || ['push'],
    });
    message = `${friendlyName} webhook added to the repository.`;
  } catch (webhookCreateError) {
    error = new Error(`The template ${templateName} defines a webhook ${friendlyName}. Adding the webhook failed. ${webhookCreateError.message()}`);
    error.inner = webhookCreateError;
  }
  return {
    error,
    message,
  };
}

async function removeOrganizationCollaboratorTask(organization: Organization, createResponse: any): Promise<IRepositoryWorkflowOutput> {
  const result = null;
  try {
    const createAccount = await organization.getAuthorizedOperationsAccount();
    const repositoryName = createResponse.name;
    const repository = organization.repository(repositoryName, createResponse);
    await repository.removeCollaborator(createAccount.login);
  } catch (ignoredError) { /* ignored */ }
  return result;
}

async function createAddTemplateFilesTask(organization: Organization, repoName: string, templateName: string): Promise<IRepositoryWorkflowOutput> {
  const { operations } = organization.getLegacySystemObjects();
  const config = operations.config;
  const templatePath = config.github.templates.directory;
  const userName = config.github.user.initialCommit.username;
  const token = config.github.user.initialCommit.token;
  const alternateTokenOptions = {
    alternateToken: token,
  };
  const repository = organization.repository(repoName);
  try {
    const templateGitHubCommitterUsername = userName;
    await authorizeTemplateCommitterAccount(repository, templateGitHubCommitterUsername, alternateTokenOptions);
    const templateRoot = path.join(templatePath, templateName);
    const fileNames = await getTemplateFilenames(templateRoot);
    const fileContents = await getFileContents(templateRoot, templatePath, templateName, fileNames);
    const message = 'Initial commit';
    const uploadedFiles = [];
    let result = {
      error: null,
      message: null,
    };
    try {
      for (let i = 0; i < fileContents.length; i++) {
        const item = fileContents[i];
        await repository.createFile(item.path, item.content, message, alternateTokenOptions);
        uploadedFiles.push(item.path);
      }
      result.message = `Initial commit of ${uploadedFiles.join(', ')} template files to the ${repository.name} repo succeeded.`;
    } catch (commitError) {
      result.error = commitError;
      const notUploaded = fileContents.map(fc => fc.path).filter(f => !uploadedFiles.includes(f));
      if (uploadedFiles.length) {
        result.message = `Initial commit of ${uploadedFiles.join(', ')} template files to the ${repository.name} repo partially succeeded. Not uploaded: ${notUploaded.join(', ')}. Error: ${commitError.message}`;
      } else {
        result.message = `Initial commit of template file(s) to the ${repository.name} repo failed. Not uploaded: ${notUploaded.join(', ')}. Error: ${commitError.message}.`;
      }
    }
    await repository.removeCollaborator(templateGitHubCommitterUsername);
    return result;
  } catch (error) {
    return { error };
  }
}

async function authorizeTemplateCommitterAccount(repository: Repository, templateGitHubCommitterUsername: string, alternateTokenOptions): Promise<void> {
  const invitation = await repository.addCollaborator(templateGitHubCommitterUsername, GitHubRepositoryPermission.Push);
  if (invitation === undefined || invitation === null) {
    // user already had permission
    return;
  }
  if (!invitation.id) {
    throw new Error(`The system account ${templateGitHubCommitterUsername} could not be invited to the ${repository.name} repository to apply the template.`);
  }
  const invitationId = invitation.id;
  await repository.acceptCollaborationInvite(invitationId, alternateTokenOptions);
}

async function addTemplateCollaborators(organization: Organization, repositoryName: string, templateName: string): Promise<IRepositoryWorkflowOutput> {
  const { operations } = organization.getLegacySystemObjects();
  const config = operations.config;
  const definitions = config.github.templates.definitions;
  const templateData = definitions ? definitions[templateName] : null;
  if (!templateData || ! templateData.collaborators) {
    return null;
  }
  const repository = organization.repository(repositoryName);
  const collaborators = templateData.collaborators;
  const errors = [];
  const messages = [];
  for (const permission of GitHubRepositoryPermissions) {
    const users = collaborators[permission];
    if (users && Array.isArray(users)) {
      for (const { username, acceptInvitationToken } of users) {
        try {
          const invitation = await repository.addCollaborator(username, permission);
          messages.push(`Added collaborator ${username} with ${permission} permission`);
          if (acceptInvitationToken) {
            const invitationId = invitation.id;
            await repository.acceptCollaborationInvite(invitationId, acceptInvitationToken);
          }
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
  }
  let error = null;
  let message = null;
  if (errors.length) {
    error = errors.join(', ');
  } else {
    message = messages.join(', ');
  }
  return {
    error,
    message,
  };
}
