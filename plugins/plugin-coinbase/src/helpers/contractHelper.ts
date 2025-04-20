import { Coinbase, readContract } from "@coinbase/coinbase-sdk";
import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { ABI } from "../constants";
import { initializeWallet } from "../utils";

// Helper function to serialize BigInt values
// biome-ignore lint/suspicious/noExplicitAny: Needed for generic serialization
const serializeBigInt = (value: any): any => {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return value.map(serializeBigInt);
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, serializeBigInt(v)]),
		);
	}
	return value;
};

/**
 * A helper class to manage contract interactions via Coinbase SDK
 */
export class ContractHelper {
	private runtime: IAgentRuntime;

	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
		this.configureCoinbase();
	}

	private configureCoinbase() {
		Coinbase.configure({
			apiKeyName:
				this.runtime.getSetting("COINBASE_API_KEY") ??
				process.env.COINBASE_API_KEY,
			privateKey:
				this.runtime.getSetting("COINBASE_PRIVATE_KEY") ??
				process.env.COINBASE_PRIVATE_KEY,
		});
	}

	/**
	 * Read data from a smart contract
	 * @param params Parameters for contract reading
	 * @returns The serialized contract response
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Needed for flexibility with different contract methods
	async readContract(params: any): Promise<any> {
		try {
			elizaLogger.debug("Reading contract with params:", params);
			const readParams = {
				...params,
				abi: params.abi || ABI, // Use provided ABI or default
			};
			const result = await readContract(readParams);
			const serializedResult = serializeBigInt(result);
			elizaLogger.debug("Contract read result (serialized):", serializedResult);
			return serializedResult;
		} catch (error) {
			elizaLogger.error("Error reading contract:", error);
			throw error;
		}
	}

	/**
	 * Invoke a method on a smart contract
	 * @param params Parameters for contract invocation
	 * @returns The contract invocation result
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Needed for flexibility with different contract methods
	async invokeContract(params: any): Promise<any> {
		try {
			elizaLogger.debug("Invoking contract with params:", params);
			const { wallet } = await initializeWallet(this.runtime, params.networkId);

			const invocationOptions = {
				contractAddress: params.contractAddress,
				method: params.method,
				abi: params.abi || ABI, // Use provided ABI or default
				args: {
					...(params.args || {}), // Ensure args is an object
					...(params.amount !== undefined && { amount: params.amount }),
				},
				networkId: params.networkId,
				...(params.assetId && { assetId: params.assetId }),
			};

			elizaLogger.info("Final invocation options:", invocationOptions);

			const invocation = await wallet.invokeContract(invocationOptions);
			await invocation.wait(); // Wait for transaction mining
			elizaLogger.debug("Contract invocation successful:", invocation);
			return invocation;
		} catch (error) {
			elizaLogger.error("Error invoking contract:", error);
			throw error;
		}
	}
}
