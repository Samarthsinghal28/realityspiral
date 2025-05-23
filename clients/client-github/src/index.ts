import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import {
	type Action,
	type Character,
	type Client,
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelClass,
	type State,
	type UUID,
	elizaLogger,
	generateObject,
	stringToUuid,
} from "@elizaos/core";
import {
	addCommentToIssueAction,
	closeIssueAction,
	closePRAction,
	createCommitAction,
	createIssueAction,
	createMemoriesFromFilesAction,
	createPullRequestAction,
	getFilesFromMemories,
	getIssuesFromMemories,
	getPullRequestsFromMemories,
	ideationAction,
	initializeRepositoryAction,
	modifyIssueAction,
	reactToIssueAction,
	reactToPRAction,
	saveIssuesToMemory,
	savePullRequestsToMemory,
} from "@realityspiral/plugin-github";
import { composeContext } from "@realityspiral/plugin-instrumentation";
import { captureError, initErrorTracking } from "@realityspiral/sentry";
import { configGithubInfoAction } from "./actions/configGithubInfo";
import { stopAction } from "./actions/stop";
import { validateGithubConfig } from "./environment";
import { configGithubInfoTemplate, oodaTemplate } from "./templates";
import {
	type ConfigGithubInfoContent,
	ConfigGithubInfoSchema,
	type OODAContent,
	OODASchema,
	isConfigGithubInfoContent,
	isOODAContent,
} from "./types";
import {
	getLastMemory,
	registerActions,
	sleep,
	unregisterActions,
} from "./utils";

// Initialize error tracking
initErrorTracking();

export class GitHubClient extends EventEmitter {
	apiToken: string;
	runtime: IAgentRuntime;
	character: Character;
	states: Map<UUID, State>;
	stopped: boolean;
	userProcesses: Map<UUID, Promise<void>>;
	actions: Action[];

	constructor(runtime: IAgentRuntime) {
		super();

		this.apiToken = runtime.getSetting("GITHUB_API_TOKEN") as string;
		this.runtime = runtime;
		this.character = runtime.character;
		this.states = new Map();
		this.stopped = false;
		this.userProcesses = new Map();
		this.actions = [
			configGithubInfoAction,
			initializeRepositoryAction,
			createMemoriesFromFilesAction,
			stopAction,
			addCommentToIssueAction,
			closeIssueAction,
			closePRAction,
			createCommitAction,
			createIssueAction,
			createPullRequestAction,
			ideationAction,
			modifyIssueAction,
			reactToIssueAction,
			reactToPRAction,
		];

		this.start();
	}

	private async start() {
		// clear the terminal
		console.clear();

		elizaLogger.info("Starting GitHub client...");

		// Register all actions
		registerActions(this.runtime, this.actions);

		// Start monitoring for new users
		await this.monitorUsers();
	}

	private async monitorUsers() {
		const githubUserCheckInterval =
			Number(this.runtime.getSetting("GITHUB_USER_CHECK_INTERVAL_MS")) || 5000; // Default to 5 seconds
		const joinRoomId = stringToUuid(`default-room-${this.runtime.agentId}`);

		while (!this.stopped) {
			let userId: UUID;
			let userRoomId: UUID;
			try {
				// First check the default room for join messages
				const joinMemories = await this.runtime.messageManager.getMemories({
					roomId: joinRoomId,
					count: 1000,
					unique: false,
				});

				// Get unique userIds from join messages
				const userIds = new Set(
					joinMemories
						.map((memory) => memory.userId)
						.filter((userId) => userId !== this.runtime.agentId),
				);

				elizaLogger.info("User IDs:", Array.from(userIds).join(", "));

				// Start process for new users with user-specific room IDs
				for (userId of userIds) {
					if (!this.userProcesses.has(userId)) {
						elizaLogger.info(`Starting process for new user: ${userId}`);
						// Create user-specific room ID
						userRoomId = stringToUuid(
							`default-room-${this.runtime.agentId}-${userId}`,
						);
						// Add user to new room
						await this.runtime.ensureConnection(
							userId,
							userRoomId,
							`user${userId}`,
							`user${userId}`,
							"github",
						);
						const process = this.startUserProcess(userId, userRoomId);
						this.userProcesses.set(userId, process);
					}
				}
			} catch (error) {
				elizaLogger.error("Error monitoring users:", error);
				captureError(error as Error, {
					userId,
					roomId: userRoomId,
					agentId: this.runtime.agentId,
					character: this.character.name,
				});
			}

			elizaLogger.info("Sleeping for 5 seconds");

			await sleep(githubUserCheckInterval);
		}
	}

	private async startUserProcess(userId: UUID, userRoomId: UUID) {
		try {
			// Use user-specific room ID for all subsequent operations
			let userState = await this.discoverGithubInfo(userId, userRoomId);
			if (!userState) {
				return;
			}
			this.states.set(userId, userState);

			// Initialize repository
			userState = await this.initializeRepository(
				userId,
				userState,
				userRoomId,
			);
			if (!userState) {
				return;
			}
			this.states.set(userId, userState);

			// Start OODA loop
			userState = await this.startOODALoop(userId, userState, userRoomId);
			if (!userState) {
				return;
			}
		} catch (error) {
			elizaLogger.error(`Error in user process for ${userId}:`, error);
			this.userProcesses.delete(userId);
			captureError(error as Error, {
				userId,
				roomId: userRoomId,
				agentId: this.runtime.agentId,
				action: "startUserProcess",
			});
		}
	}

	private async discoverGithubInfo(
		userId: UUID,
		userRoomId: UUID,
	): Promise<State | null> {
		// init state
		let state: State | null = null;

		const githubInfoDiscoveryInterval =
			Number(this.runtime.getSetting("GITHUB_INFO_DISCOVERY_INTERVAL_MS")) ||
			1000; // Default to 1 second

		await sleep(githubInfoDiscoveryInterval);

		// github info discovery loop
		while (true) {
			if (this.stopped) {
				unregisterActions(this.runtime, this.actions);
				elizaLogger.info("GitHubClient stopped successfully.");
				return;
			}
			if (!this.userProcesses.has(userId)) {
				elizaLogger.info(
					`User ${userId} not found in userProcesses, stopping user discovery github info cycle.`,
				);
				return null;
			}

			elizaLogger.info("Processing Github info discovery cycle...");

			const message = await getLastMemory(this.runtime, userRoomId);

			// if message is null skip the github info discovery cycle
			if (!message) {
				elizaLogger.info(
					"No memories found, skip to the next github info discovery cycle.",
				);
				await sleep(githubInfoDiscoveryInterval);
				continue;
			}

			if (!state) {
				state = (await this.runtime.composeState(message)) as State;
			} else {
				state = await this.runtime.updateRecentMessageState(state);
			}

			const context = composeContext({
				state,
				template: configGithubInfoTemplate,
			});

			const details = await generateObject({
				runtime: this.runtime,
				context,
				modelClass: ModelClass.SMALL,
				schema: ConfigGithubInfoSchema,
			});

			if (!isConfigGithubInfoContent(details.object)) {
				const errorMessage = "Invalid content";
				elizaLogger.error(`${errorMessage}: ${details.object}`);
				captureError(new Error(errorMessage), {
					userId,
					roomId: userRoomId,
					agentId: this.runtime.agentId,
					action: "discoverGithubInfo",
				});
				throw new Error(errorMessage);
			}

			const content = details.object as ConfigGithubInfoContent;

			await fs.writeFile(
				"/tmp/client-github-content.txt",
				JSON.stringify(content, null, 2),
			);

			// if content has the owner, repo and branch fields set, then we can stop the github info discovery cycle
			if (content.owner && content.repo && content.branch) {
				if (content.owner === "octocat" && content.repo === "hello-world") {
					elizaLogger.info(
						`Wrong pick ${content.owner}/${content.repo}, try again...`,
					);
					await sleep(githubInfoDiscoveryInterval);
					continue;
				}

				elizaLogger.info(
					`Repository configuration complete for ${content.owner}/${content.repo} on ${content.branch} branch`,
				);

				state.owner = content.owner;
				state.repo = content.repo;
				state.branch = content.branch;

				// stop the github info discovery loop
				break;
			}

			await sleep(githubInfoDiscoveryInterval);
		}

		// sleep for 5 seconds
		await sleep(5000);

		// return user state
		return state;
	}

	private async initializeRepository(
		userId: UUID,
		state: State,
		userRoomId: UUID,
	): Promise<State | null> {
		const initializeRepositoryMemoryTimestamp = Date.now();
		const initializeRepositoryMemory: Memory = {
			id: stringToUuid(
				`${userRoomId}-${this.runtime.agentId}-${userId}-${initializeRepositoryMemoryTimestamp}-initialize-repository`,
			),
			userId,
			agentId: this.runtime.agentId,
			content: {
				text: `Initialize the repository ${state.owner}/${state.repo} on ${state.branch} branch`,
				action: "INITIALIZE_REPOSITORY",
				source: "github",
				inReplyTo: userId,
			},
			roomId: userRoomId,
			createdAt: initializeRepositoryMemoryTimestamp,
		};
		await this.runtime.messageManager.createMemory(initializeRepositoryMemory);

		const createMemoriesFromFilesMemoryTimestamp = Date.now();
		const createMemoriesFromFilesMemory = {
			id: stringToUuid(
				`${userRoomId}-${this.runtime.agentId}-${userId}-${createMemoriesFromFilesMemoryTimestamp}-create-memories-from-files`,
			),
			userId,
			agentId: this.runtime.agentId,
			content: {
				text: `Create memories from files for the repository ${state.owner}/${state.repo} @ branch ${state.branch} and path '/'`,
				action: "CREATE_MEMORIES_FROM_FILES",
				source: "github",
				inReplyTo: userId,
			},
			roomId: userRoomId,
			createdAt: createMemoriesFromFilesMemoryTimestamp,
		};
		await this.runtime.messageManager.createMemory(
			createMemoriesFromFilesMemory,
		);

		const message = await getLastMemory(this.runtime, userRoomId);

		// if message is null throw an error
		if (!message) {
			const error = new Error(
				"No message found, repo init loop cannot continue.",
			);
			elizaLogger.error(error.message);
			captureError(error, {
				agentId: this.runtime.agentId,
				userId,
				roomId: userRoomId,
				action: "initializeRepository",
			});
			throw error;
		}

		const issuesLimit =
			Number(this.runtime.getSetting("GITHUB_ISSUES_LIMIT")) || 10;
		const pullRequestsLimit =
			Number(this.runtime.getSetting("GITHUB_PULL_REQUESTS_LIMIT")) || 10;

		// save issues and pull requests to memory
		await saveIssuesToMemory(
			userId,
			this.runtime,
			message,
			state.owner as string,
			state.repo as string,
			state.branch as string,
			this.apiToken,
			issuesLimit,
			true,
		);
		await savePullRequestsToMemory(
			userId,
			this.runtime,
			message,
			state.owner as string,
			state.repo as string,
			state.branch as string,
			this.apiToken,
			pullRequestsLimit,
			true,
		);

		const callback: HandlerCallback = async (content: Content) => {
			const timestamp = Date.now();

			const responseMemory: Memory = {
				id: stringToUuid(
					`${userRoomId}-${this.runtime.agentId}-${userId}-${timestamp}-${content.action}-response`,
				),
				agentId: this.runtime.agentId,
				userId,
				content: {
					...content,
					user: this.runtime.character.name,
					inReplyTo:
						content.action === "INITIALIZE_REPOSITORY"
							? initializeRepositoryMemory.id
							: createMemoriesFromFilesMemory.id,
				},
				roomId: userRoomId,
				createdAt: timestamp,
			};

			// print responseMemory
			elizaLogger.info("responseMemory: ", responseMemory);

			if (responseMemory.content.text?.trim()) {
				await this.runtime.messageManager.createMemory(responseMemory);
				// biome-ignore lint/style/noParameterAssign: <explanation>
				state = await this.runtime.updateRecentMessageState(state);
			} else {
				const errorMessage = "Empty response, skipping";
				elizaLogger.error(errorMessage);
				captureError(new Error(errorMessage), {
					userId,
					roomId: userRoomId,
					agentId: this.runtime.agentId,
					action: "initializeRepository",
				});
			}

			return [responseMemory];
		};

		await this.runtime.processActions(
			message,
			[initializeRepositoryMemory, createMemoriesFromFilesMemory],
			state,
			callback,
		);

		// get memories and write it to file
		const memoriesPostRepoInitProcessActions =
			await this.runtime.messageManager.getMemories({
				roomId: userRoomId,
				count: 1000,
			});
		await fs.writeFile(
			"/tmp/client-github-memories-post-repo-init-process-actions.txt",
			JSON.stringify(memoriesPostRepoInitProcessActions, null, 2),
		);

		// get state and write it to file
		await fs.writeFile(
			"/tmp/client-github-state-post-repo-init-process-actions.txt",
			JSON.stringify(state, null, 2),
		);

		const githubRepoInitInterval =
			Number(this.runtime.getSetting("GITHUB_REPO_INIT_INTERVAL_MS")) || 5000; // Default to 5 second

		await sleep(githubRepoInitInterval);

		// repo init loop
		while (true) {
			if (this.stopped) {
				unregisterActions(this.runtime, this.actions);
				elizaLogger.info("GitHubClient stopped successfully.");
				return null;
			}
			if (!this.userProcesses.has(userId)) {
				elizaLogger.info(
					`User ${userId} not found in userProcesses, stopping user initialize repository cycle.`,
				);
				return null;
			}

			elizaLogger.info("Processing repo init cycle...");

			// retrieve memories
			const memories = await this.runtime.messageManager.getMemories({
				roomId: userRoomId,
			});

			await fs.writeFile(
				"/tmp/client-github-memories.txt",
				JSON.stringify(memories, null, 2),
			);

			// if memories is empty skip to the next repo init cycle
			if (memories.length === 0) {
				elizaLogger.info(
					"No memories found, skipping to the next repo init cycle.",
				);
				await sleep(githubRepoInitInterval);
				continue;
			}

			// retrieve last message
			const message = memories[0];

			// retrieve files from memories
			const files = await getFilesFromMemories(this.runtime, message);

			if (files.length === 0) {
				elizaLogger.info(
					"No files found, skipping to the next repo init cycle.",
				);
				await sleep(githubRepoInitInterval);
				continue;
			}

			// if files are found, set files, issues and PRs to state and stop the repo init loop
			state.files = files;

			const previousIssues = await getIssuesFromMemories(this.runtime, message);
			state.previousIssues = JSON.stringify(
				previousIssues.map((issue) => ({
					title: issue.content.text,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					body: (issue.content.metadata as any).body,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					url: (issue.content.metadata as any).url,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					number: (issue.content.metadata as any).number,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					state: (issue.content.metadata as any).state,
				})),
				null,
				2,
			);

			const previousPRs = await getPullRequestsFromMemories(
				this.runtime,
				message,
			);
			state.previousPRs = JSON.stringify(
				previousPRs.map((pr) => ({
					title: pr.content.text,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					body: (pr.content.metadata as any).body,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					url: (pr.content.metadata as any).url,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					number: (pr.content.metadata as any).number,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					state: (pr.content.metadata as any).state,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					diff: (pr.content.metadata as any).diff,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					comments: (pr.content.metadata as any).comments,
				})),
				null,
				2,
			);

			break;
		}

		await sleep(githubRepoInitInterval);

		// return user state
		return state;
	}

	private async startOODALoop(
		userId: UUID,
		state: State,
		userRoomId: UUID,
	): Promise<State | null> {
		const githubOodaInterval =
			Number(this.runtime.getSetting("GITHUB_OODA_INTERVAL_MS")) || 60000; // Default to 1 minute

		// ooda loop
		while (true) {
			if (this.stopped) {
				unregisterActions(this.runtime, this.actions);
				elizaLogger.info("GitHubClient stopped successfully.");
				return null;
			}
			if (!this.userProcesses.has(userId)) {
				elizaLogger.info(
					`User ${userId} not found in userProcesses, stopping user OODA cycle.`,
				);
				return null;
			}

			elizaLogger.info("Processing OODA cycle...");

			const message = await getLastMemory(this.runtime, userRoomId);

			await fs.writeFile(
				"/tmp/client-github-message.txt",
				JSON.stringify(message, null, 2),
			);

			// if message is null skip to the next ooda cycle
			if (!message) {
				elizaLogger.info("No message found, skipping to the next OODA cycle.");
				await sleep(githubOodaInterval);
				continue;
			}

			if (!state) {
				// biome-ignore lint/style/noParameterAssign: <explanation>
				state = (await this.runtime.composeState(message)) as State;
			} else {
				// biome-ignore lint/style/noParameterAssign: <explanation>
				state = await this.runtime.updateRecentMessageState(state);
			}

			const context = composeContext({
				state,
				template: oodaTemplate,
			});

			await fs.writeFile("/tmp/client-github-context.txt", context);

			const details = await generateObject({
				runtime: this.runtime,
				context,
				modelClass: ModelClass.SMALL,
				schema: OODASchema,
			});

			if (!isOODAContent(details.object)) {
				const errorMessage = "Invalid content";
				elizaLogger.error(errorMessage);
				captureError(new Error(errorMessage), {
					userId,
					roomId: userRoomId,
					agentId: this.runtime.agentId,
					action: "startOODALoop",
				});
				throw new Error(errorMessage);
			}

			const content = details.object as OODAContent;

			await fs.writeFile(
				"/tmp/client-github-content.txt",
				JSON.stringify(content, null, 2),
			);

			if (content.action === "STOP") {
				elizaLogger.info("Stopping the OODA loop...");
				this.stopUserProcess(userId);
				continue;
			}

			if (content.action === "NOTHING") {
				elizaLogger.info(
					"Skipping to the next OODA cycle as action is NOTHING",
				);
				await sleep(githubOodaInterval);
				continue;
			}

			// create new memory with retry logic
			const timestamp = Date.now();
			const actionMemory: Memory = {
				id: stringToUuid(
					`${userRoomId}-${this.runtime.agentId}-${userId}-${timestamp}-${content.action}`,
				),
				userId,
				agentId: this.runtime.agentId,
				content: {
					text: `Going to execute action: ${content.action}`,
					action: content.action,
					source: "github",
					inReplyTo: userId,
				},
				roomId: userRoomId,
				createdAt: timestamp,
			};

			try {
				await this.runtime.messageManager.createMemory(actionMemory);
			} catch (error) {
				const errorMessage = "Error creating memory";
				elizaLogger.error(errorMessage);
				captureError(new Error(errorMessage), {
					userId,
					roomId: userRoomId,
					agentId: this.runtime.agentId,
					action: "startOODALoop",
				});
				throw error; // Re-throw other errors
			}

			const callback: HandlerCallback = async (
				content: Content,
				// biome-ignore lint/suspicious/noExplicitAny: <explanation>
				_files: any[],
			) => {
				elizaLogger.info("Callback called with content:", content);
				return [];
			};

			// process the actions with the new memory and state
			elizaLogger.info("Processing actions for action:", content.action);
			await this.runtime.processActions(
				message,
				[actionMemory],
				state,
				callback,
			);

			elizaLogger.info("OODA cycle completed.");

			await sleep(githubOodaInterval);
		}
	}

	private async stopUserProcess(userId: UUID) {
		this.userProcesses.delete(userId);
		this.states.delete(userId);
		elizaLogger.info(`Stopped user process for user ${userId}`);
	}

	stop() {
		this.stopped = true;
		// Clean up user processes
		this.userProcesses.clear();
		this.states.clear();
	}
}

export const GitHubClientInterface: Client = {
	start: async (runtime: IAgentRuntime) => {
		const _config = await validateGithubConfig(runtime);

		elizaLogger.info("Starting GitHub client with agent ID:", runtime.agentId);

		const client = new GitHubClient(runtime);
		return client;
	},
	stop: async (runtime: IAgentRuntime) => {
		try {
			elizaLogger.info("Stopping GitHub client");
			await runtime.clients.github.stop();
		} catch (e) {
			elizaLogger.error("GitHub client stop error:", e);
			captureError(e as Error, {
				agentId: runtime.agentId,
				action: "stop",
			});
		}
	},
};

export default GitHubClientInterface;
