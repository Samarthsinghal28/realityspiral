import { randomUUID } from "crypto";
import {
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type State,
	generateObject,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractHelper } from "../src/helpers/contractHelper";
import {
	invokeContractAction,
	readContractAction,
} from "../src/plugins/tokenContract";
import { ContractInvocationSchema, ReadContractSchema } from "../src/types";

// Mock dependencies
vi.mock("@elizaos/core", async () => {
	const actual = await vi.importActual("@elizaos/core");
	return {
		...actual,
		elizaLogger: {
			debug: vi.fn(),
			info: vi.fn(),
			error: vi.fn(),
		},
		generateObject: vi.fn(),
	};
});

vi.mock("../src/helpers/contractHelper", () => ({
	ContractHelper: vi.fn(),
}));

vi.mock("@realityspiral/plugin-instrumentation", () => ({
	composeContext: vi.fn((args) => args),
	traceResult: vi.fn((state, response) => response),
}));

vi.mock("csv-writer", () => ({
	createArrayCsvWriter: vi.fn(() => ({
		writeRecords: vi.fn(),
	})),
}));

vi.mock("../src/types", async () => {
	const actual = await vi.importActual("../src/types");
	return {
		...actual,
		isReadContractContent: vi.fn(() => true),
		isContractInvocationContent: vi.fn(() => true),
	};
});

describe("tokenContract Actions", () => {
	let mockRuntime: IAgentRuntime;
	let mockMemory: Memory;
	let mockState: unknown; // Using unknown to silence the type errors
	let mockCallback: HandlerCallback;

	beforeEach(() => {
		vi.clearAllMocks();

		mockRuntime = {
			getSetting: vi.fn((key) => {
				if (key === "COINBASE_API_KEY") return "test-api-key";
				if (key === "COINBASE_PRIVATE_KEY") return "test-private-key";
				return null;
			}),
			character: { settings: { secrets: {} } },
		} as unknown as IAgentRuntime;

		mockMemory = {
			id: randomUUID(),
			userId: randomUUID(),
			agentId: randomUUID(),
			roomId: randomUUID(),
			content: { text: "Test" },
			createdAt: Date.now(),
		} as Memory;

		// Create mock state with required properties
		mockState = {
			history: [mockMemory],
			variables: {},
			bio: "",
			lore: "",
			messageDirections: "",
			postDirections: "",
			thinkingProcessPatterns: [] as string[],
			characterSheet: {},
			knowledge: "",
			persona: {},
			roomId: randomUUID(),
			actors: "",
			recentMessages: "",
			recentMessagesData: [],
		};

		mockCallback = vi.fn().mockResolvedValue([]) as HandlerCallback;
	});

	describe("readContractAction", () => {
		it("should successfully read contract data", async () => {
			// Setup
			const mockReadDetails = {
				contractAddress: "0x123",
				method: "balanceOf",
				args: { owner: "0xabc" },
				networkId: "base",
			};
			const mockReadResult = { balance: "1000" };

			vi.mocked(generateObject).mockResolvedValue({
				object: mockReadDetails,
			} as any);
			const mockReadContract = vi.fn().mockResolvedValue(mockReadResult);
			vi.mocked(ContractHelper).mockImplementation(() => ({
				readContract: mockReadContract,
			}));

			// Execute
			await readContractAction.handler(
				mockRuntime,
				mockMemory,
				mockState as State,
				{},
				mockCallback,
			);

			// Assert
			expect(ContractHelper).toHaveBeenCalledWith(mockRuntime);
			expect(mockReadContract).toHaveBeenCalledWith({
				networkId: mockReadDetails.networkId,
				contractAddress: mockReadDetails.contractAddress,
				method: mockReadDetails.method,
				args: mockReadDetails.args,
				abi: expect.anything(),
			});
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining("Contract read successful:"),
				}),
				[],
			);
		});

		it("should handle errors during contract read", async () => {
			// Setup
			const mockReadDetails = {
				contractAddress: "0x123",
				method: "balanceOf",
				args: { owner: "0xabc" },
				networkId: "base",
			};
			const mockError = new Error("Read error");

			vi.mocked(generateObject).mockResolvedValue({
				object: mockReadDetails,
			} as any);
			const mockReadContract = vi.fn().mockRejectedValue(mockError);
			vi.mocked(ContractHelper).mockImplementation(() => ({
				readContract: mockReadContract,
			}));

			// Execute
			await readContractAction.handler(
				mockRuntime,
				mockMemory,
				mockState as State,
				{},
				mockCallback,
			);

			// Assert
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining("Failed to read contract: Read error"),
				}),
				[],
			);
		});
	});

	describe("invokeContractAction", () => {
		it("should successfully invoke a contract method", async () => {
			// Setup
			const mockInvocationDetails = {
				contractAddress: "0x456",
				method: "transfer",
				args: { to: "0xdef", amount: "500" },
				amount: "500",
				assetId: "wei",
				networkId: "base",
			};
			const mockInvocationResult = {
				getStatus: vi.fn(() => "SUCCESS"),
				getTransactionLink: vi.fn(() => "http://tx.example.com"),
			};

			vi.mocked(generateObject).mockResolvedValue({
				object: mockInvocationDetails,
			} as any);
			const mockInvokeContract = vi
				.fn()
				.mockResolvedValue(mockInvocationResult);
			vi.mocked(ContractHelper).mockImplementation(() => ({
				invokeContract: mockInvokeContract,
			}));

			// Execute
			await invokeContractAction.handler(
				mockRuntime,
				mockMemory,
				mockState as State,
				{},
				mockCallback,
			);

			// Assert
			expect(ContractHelper).toHaveBeenCalledWith(mockRuntime);
			expect(mockInvokeContract).toHaveBeenCalledWith({
				contractAddress: mockInvocationDetails.contractAddress,
				method: mockInvocationDetails.method,
				args: mockInvocationDetails.args,
				amount: mockInvocationDetails.amount,
				assetId: mockInvocationDetails.assetId,
				networkId: mockInvocationDetails.networkId,
				abi: expect.anything(),
			});
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining(
						"Contract method invoked successfully:",
					),
				}),
				[],
			);
		});

		it("should handle errors during contract invocation", async () => {
			// Setup
			const mockInvocationDetails = {
				contractAddress: "0x456",
				method: "transfer",
				args: { to: "0xdef", amount: "500" },
				amount: "500",
				assetId: "wei",
				networkId: "base",
			};
			const mockError = new Error("Invocation error");

			vi.mocked(generateObject).mockResolvedValue({
				object: mockInvocationDetails,
			} as any);
			const mockInvokeContract = vi.fn().mockRejectedValue(mockError);
			vi.mocked(ContractHelper).mockImplementation(() => ({
				invokeContract: mockInvokeContract,
			}));

			// Execute
			await invokeContractAction.handler(
				mockRuntime,
				mockMemory,
				mockState as State,
				{},
				mockCallback,
			);

			// Assert
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining(
						"Failed to invoke contract method: Invocation error",
					),
				}),
				[],
			);
		});
	});
});
