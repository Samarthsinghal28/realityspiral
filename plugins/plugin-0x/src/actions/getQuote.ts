import { createClientV2 } from "@0x/swap-ts-sdk";
import {
	type Action,
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	MemoryManager,
	type State,
	elizaLogger,
} from "@elizaos/core";
import { traceResult } from "@realityspiral/plugin-instrumentation";
import { formatUnits } from "viem";
import { CHAIN_NAMES, NATIVE_TOKENS, ZX_MEMORY } from "../constants";
import type { GetQuoteResponse, PriceInquiry, Quote } from "../types";
import { formatTokenAmount } from "../utils";
import { TOKENS } from "../utils";

export const getQuote: Action = {
	name: "GET_QUOTE_0X",
	similes: [],
	suppressInitialMessage: true,
	description:
		"Get a firm quote for a swap from 0x when user wants to execute a trade. This action is triggered only after user has requested for an indicative price.",
	validate: async (runtime: IAgentRuntime) => {
		return !!runtime.getSetting("ZERO_EX_API_KEY");
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		_options: Record<string, unknown>,
		callback: HandlerCallback,
	) => {
		const latestPriceInquiry = await retrieveLatestPriceInquiry(
			runtime,
			message,
		);
		if (!latestPriceInquiry) {
			callback({
				text: "Please provide me the details of the swap.",
			});
			return;
		}

		const { sellTokenObject, sellAmountBaseUnits, buyTokenObject, chainId } =
			latestPriceInquiry;

		const zxClient = createClientV2({
			apiKey: runtime.getSetting("ZERO_EX_API_KEY"),
		});

		try {
			const quote = (await zxClient.swap.permit2.getQuote.query({
				sellAmount: sellAmountBaseUnits,
				sellToken: sellTokenObject.address,
				buyToken: buyTokenObject.address,
				chainId: chainId,
				taker: "0x0000000000000000000000000000000000000000",
			})) as GetQuoteResponse;

			await storeQuoteToMemory(runtime, message, {
				sellTokenObject,
				buyTokenObject,
				sellAmountBaseUnits,
				chainId,
				quote,
				timestamp: new Date().toISOString(),
			});

			if (!quote.liquidityAvailable) {
				callback({
					text: "No liquidity available for this swap. Please try again with a different token or amount.",
				});
				return;
			}

			const buyAmountBaseUnitsQuoted = formatUnits(
				BigInt(quote?.buyAmount),
				buyTokenObject.decimals,
			);

			const sellAmountBaseUnitsQuoted = formatUnits(
				BigInt(quote?.sellAmount),
				sellTokenObject.decimals,
			);

			const warnings = [];
			if (quote.issues?.balance) {
				warnings.push(
					"⚠️ Warnings:",
					`  • Insufficient balance (Have ${formatTokenAmount(
						quote.issues.balance.actual,
						quote.issues.balance.token,
						chainId,
					)})`,
				);
			}

			const formattedResponse = [
				"🎯 Firm Quote Details:",
				"────────────────",
				// Basic swap details (same as price)
				`📤 Sell: ${formatTokenAmount(
					quote.sellAmount,
					sellTokenObject.address,
					chainId,
				)}`,
				`📥 Buy: ${formatTokenAmount(
					quote?.buyAmount,
					buyTokenObject.address,
					chainId,
				)}`,
				`📊 Rate: 1 ${sellTokenObject.symbol} = ${(
					Number(buyAmountBaseUnitsQuoted) / Number(sellAmountBaseUnitsQuoted)
				).toFixed(4)} ${buyTokenObject.symbol}`,

				// New information specific to quote
				`💱 Minimum Buy Amount: ${formatTokenAmount(
					quote.minBuyAmount,
					quote.buyToken,
					chainId,
				)}`,

				// Fee breakdown
				"💰 Fees Breakdown:",
				`  • 0x Protocol Fee: ${formatTokenAmount(
					quote.fees.zeroExFee?.amount,
					quote.fees.zeroExFee?.token,
					chainId,
				)}`,
				`  • Integrator Fee: ${formatTokenAmount(
					quote.fees.integratorFee?.amount,
					quote.fees.integratorFee?.token,
					chainId,
				)}`,
				`  • Network Gas Fee: ${
					quote.totalNetworkFee
						? formatTokenAmount(
								quote.totalNetworkFee,
								NATIVE_TOKENS[chainId].address,
								chainId,
							)
						: "Will be estimated at execution"
				}`,

				...formatRouteInfo(quote),

				// Chain
				`🔗 Chain: ${CHAIN_NAMES[chainId]}`,

				...(warnings.length > 0 ? warnings : []),

				"────────────────",
				"💫 Ready to execute? Type 'execute' to continue",
			]
				.filter(Boolean)
				.join("\n");

			const response: Content = {
				text: formattedResponse,
			};

			callback(response);

			traceResult(state, response);

			return true;
		} catch (error) {
			elizaLogger.error("Error getting quote:", error);
			if (callback) {
				callback({
					text: `Error getting quote: ${error.message}`,
					content: { error: error.message || String(error) },
				});
			}
			return false;
		}
	},
	examples: [
		[
			{
				user: "{{user1}}",
				content: {
					text: "Get me a quote for 500 USDC to WETH on Optimism",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "I'll fetch a firm quote for swapping 500 USDC to WETH on Optimism.",
					action: "GET_QUOTE_0X",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Quote for 2.5 WETH to USDT on Arbitrum please",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "I'll get you a firm quote for swapping 2.5 WETH to USDT on Arbitrum.",
					action: "GET_QUOTE_0X",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "quote 100 MATIC to USDC on Polygon",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "I'll fetch a firm quote for swapping 100 MATIC to USDC on Polygon.",
					action: "GET_QUOTE_0X",
				},
			},
		],
	],
};

// const formatTime = (time: string) => {
//     const expirationDate = new Date(parseInt(time) * 1000);

//     // Format: "Mar 15, 2:30 PM"
//     const formattedTime = expirationDate.toLocaleString(undefined, {
//         month: "short",
//         day: "numeric",
//         hour: "numeric",
//         minute: "2-digit",
//         hour12: true,
//     });

//     return `${formattedTime}`;
// };

export const retrieveLatestPriceInquiry = async (
	runtime: IAgentRuntime,
	message: Memory,
): Promise<PriceInquiry | null> => {
	const memoryManager = new MemoryManager({
		runtime,
		tableName: ZX_MEMORY.price.tableName,
	});

	try {
		const memories = await memoryManager.getMemories({
			roomId: message.roomId,
			count: 1,
			start: 0,
			end: Date.now(),
		});

		if (memories?.[0]) {
			return JSON.parse(memories[0].content.text) as PriceInquiry;
		}
		return null;
	} catch (error) {
		elizaLogger.error("Failed to retrieve price inquiry:", error.message);
		return null;
	}
};

export const storeQuoteToMemory = async (
	runtime: IAgentRuntime,
	message: Memory,
	quote: Quote,
) => {
	const memory: Memory = {
		roomId: message.roomId,
		userId: message.userId,
		agentId: runtime.agentId,
		content: {
			text: JSON.stringify(quote),
			type: ZX_MEMORY.quote.type,
		},
	};

	const memoryManager = new MemoryManager({
		runtime,
		tableName: ZX_MEMORY.quote.tableName,
	});

	await memoryManager.createMemory(memory);
};

/**
 * @returns example:
 * 🛣️ Route:
 * WETH → DAI → LINK
 *  • WETH → DAI: 100% via Uniswap_V3
 *  • DAI → LINK: 14.99% via Uniswap_V3, 85.01% via Uniswap_V3
 */

export const formatRouteInfo = (quote: GetQuoteResponse): string[] => {
	if (!quote.route.tokens || !quote.route.fills) {
		return [];
	}
	// Get unique route path
	const routeTokens = quote.route.tokens;
	const routePath = routeTokens.map((t) => t.symbol).join(" → ");

	// Group fills by token pairs
	const fillsByPair = quote.route.fills.reduce(
		(acc, fill) => {
			const key = `${fill.from}-${fill.to}`;
			if (!acc[key]) acc[key] = [];
			acc[key].push(fill);
			return acc;
		},
		{} as Record<string, typeof quote.route.fills>,
	);

	// Format each pair's route details
	const routeDetails = Object.entries(fillsByPair).map(([pair, fills]) => {
		const [fromAddr, toAddr] = pair.split("-");
		const from = routeTokens.find(
			(t) => t.address.toLowerCase() === fromAddr.toLowerCase(),
		)?.symbol;
		const to = routeTokens.find(
			(t) => t.address.toLowerCase() === toAddr.toLowerCase(),
		)?.symbol;

		if (fills.length === 1) {
			return `  • ${from} → ${to}: ${
				Number(fills[0].proportionBps) / 100
			}% via ${fills[0].source}`;
		}
		return [
			`  • ${from} → ${to}:`,
			...fills.map((f) => `${Number(f.proportionBps) / 100}% via ${f.source}`),
		].join(", ");
	});

	return ["🛣️ Route:", routePath, ...routeDetails];
};

export const getQuoteObj = async (
	runtime: IAgentRuntime,
	priceInquiry: PriceInquiry,
	address: string,
) => {
	const { sellTokenObject, sellAmountBaseUnits, buyTokenObject, chainId } =
		priceInquiry;

	const zxClient = createClientV2({
		apiKey: runtime.getSetting("ZERO_EX_API_KEY"),
	});

	const maxRetries = 6;
	let attempt = 0;

	while (attempt < maxRetries) {
		try {
			const quote = (await zxClient.swap.allowanceHolder.getQuote.query({
				sellAmount: sellAmountBaseUnits,
				sellToken: sellTokenObject.address,
				buyToken: buyTokenObject.address,
				chainId: chainId,
				taker: address,
			})) as GetQuoteResponse;
			if (!quote.liquidityAvailable) {
				elizaLogger.info(
					"No liquidity available for this swap. Please try again with a different token or amount.",
				);
				return;
			}

			const buyAmountBaseUnitsQuoted = formatUnits(
				BigInt(quote?.buyAmount),
				buyTokenObject.decimals,
			);
			elizaLogger.info(`buyAmountBaseUnitsQuoted: ${buyAmountBaseUnitsQuoted}`);

			const sellAmountBaseUnitsQuoted = formatUnits(
				BigInt(quote.sellAmount),
				sellTokenObject.decimals,
			);
			elizaLogger.info(
				`sellAmountBaseUnitsQuoted: ${sellAmountBaseUnitsQuoted}`,
			);

			const warnings = [];
			if (quote.issues?.balance) {
				warnings.push(
					"⚠️ Warnings:",
					`  • Insufficient balance (Have ${formatTokenAmountManual(
						quote.issues.balance.actual,
						quote.issues.balance.token,
						sellTokenObject.symbol,
					)})`,
				);
			}
			elizaLogger.info(`warnings: ${warnings}`);
			const formattedResponse = [
				"🎯 Firm Quote Details:",
				"────────────────",
				// Basic swap details (same as price)
				`📤 Sell: ${formatTokenAmountManual(
					quote.sellAmount,
					sellTokenObject.address,
					sellTokenObject.symbol,
				)}`,
				`📥 Buy: ${formatTokenAmountManual(
					quote?.buyAmount,
					buyTokenObject.address,
					buyTokenObject.symbol,
				)}`,
				`📊 Rate: 1 ${sellTokenObject.symbol} = ${(
					Number(buyAmountBaseUnitsQuoted) / Number(sellAmountBaseUnitsQuoted)
				).toFixed(4)} ${buyTokenObject.symbol}`,

				// New information specific to quote
				`💱 Minimum Buy Amount: ${formatTokenAmountManual(
					quote.minBuyAmount,
					quote.buyToken,
					buyTokenObject.symbol,
				)}`,

				// Fee breakdown
				"💰 Fees Breakdown:",
				`  • 0x Protocol Fee: ${formatTokenAmountManual(
					quote.fees.zeroExFee?.amount,
					quote.fees.zeroExFee?.token,
					sellTokenObject.symbol,
				)}`,
				`  • Integrator Fee: ${formatTokenAmountManual(
					quote.fees.integratorFee?.amount,
					quote.fees.integratorFee?.token,
					sellTokenObject.symbol,
				)}`,
				`  • Network Gas Fee: ${
					quote.totalNetworkFee
						? formatTokenAmountManual(
								quote.totalNetworkFee,
								NATIVE_TOKENS[chainId].address,
								NATIVE_TOKENS[chainId].symbol,
							)
						: "Will be estimated at execution"
				}`,

				...formatRouteInfo(quote),

				// Chain
				`🔗 Chain: ${CHAIN_NAMES[chainId]}`,

				...(warnings.length > 0 ? warnings : []),

				"────────────────",
			]
				.filter(Boolean)
				.join("\n");
			elizaLogger.info(formattedResponse);
			return quote;
		} catch (error) {
			attempt++;
			elizaLogger.error(
				`Error getting quote (attempt ${attempt}):`,
				error.message,
			);
			if (attempt >= maxRetries) {
				return null;
			}
			await new Promise((resolve) => setTimeout(resolve, 5000)); // Sleep for 5 second before retrying
		}
	}
	return null;
};

/**
 * Formats a token amount with its symbol
 * @param amount The amount in base units (e.g., wei)
 * @param address The token address
 * @param chainId The chain ID (defaults to 1 for Ethereum mainnet)
 * @returns Formatted string like "1.234567 USDC"
 */
export function formatTokenAmountManual(
	amount: string,
	_address: string,
	ticker: string,
): string {
	// elizaLogger.info('formatTokenAmountManual', amount, address, ticker)
	if (!amount) return "0";
	// check if in TOKENS
	const token = TOKENS[ticker];
	if (!token) throw new Error(`Token not found for address: ${ticker}`);
	// if (token.address.toLowerCase() !== address.toLowerCase()) {
	//     throw new Error(`Token address does not match: ${token.address} !== ${address}`);
	// }

	const parsedAmount = formatUnits(BigInt(amount), token.decimals);
	return `${Number(parsedAmount).toFixed(token.decimals)} ${token.symbol}`;
}
