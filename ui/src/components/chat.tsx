import { Button } from "@/components/ui/button";
import {
	ChatBubble,
	ChatBubbleMessage,
	ChatBubbleTimestamp,
} from "@/components/ui/chat/chat-bubble";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";
import { useToast } from "@/hooks/use-toast";
import { apiClient } from "@/lib/api";
import { cn, getSessionId, moment } from "@/lib/utils";
import type { IAttachment } from "@/types";
import type { Content, UUID } from "@elizaos/core";
import { type AnimatedProps, animated, useTransition } from "@react-spring/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import AIWriter from "react-aiwriter";
import { AudioRecorder } from "./audio-recorder";
import CopyButton from "./copy-button";
import { Avatar, AvatarImage } from "./ui/avatar";
import { Badge } from "./ui/badge";
import ChatTtsButton from "./ui/chat/chat-tts-button";
import { useAutoScroll } from "./ui/chat/hooks/useAutoScroll";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ExtraContentFields {
	id?: string;
	user: string;
	createdAt: number;
	isLoading?: boolean;
}

type ContentWithUser = Content & ExtraContentFields;

type AnimatedDivProps = AnimatedProps<{ style: React.CSSProperties }> & {
	children?: React.ReactNode;
};

// Helper function to save messages to local storage
const saveMessagesToLocalStorage = (
	agentId: UUID,
	messages: ContentWithUser[],
) => {
	try {
		const sessionId = getSessionId();
		localStorage.setItem(
			`chat_messages_${agentId}_${sessionId}`,
			JSON.stringify(messages),
		);
	} catch (error) {
		console.error("Error saving messages to local storage:", error);
	}
};

// Helper function to deduplicate messages based on text content
const deduplicateMessages = (
	messages: ContentWithUser[],
): ContentWithUser[] => {
	const uniqueMessages = [];
	const seenTexts = new Set();

	for (const message of messages) {
		if (!seenTexts.has(message.text)) {
			seenTexts.add(message.text);
			uniqueMessages.push(message);
		}
	}

	return uniqueMessages;
};

// Helper function to get messages from local storage
const getMessagesFromLocalStorage = (agentId: UUID): ContentWithUser[] => {
	try {
		const sessionId = getSessionId();
		const storedMessages = localStorage.getItem(
			`chat_messages_${agentId}_${sessionId}`,
		);
		const messages = storedMessages ? JSON.parse(storedMessages) : [];
		return deduplicateMessages(messages);
	} catch (error) {
		console.error("Error retrieving messages from local storage:", error);
		return [];
	}
};

export default function Page({ agentId }: { agentId: UUID }) {
	const { toast } = useToast();
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const formRef = useRef<HTMLFormElement>(null);

	const queryClient = useQueryClient();

	const getMessageVariant = (role: string) =>
		role !== "user" ? "received" : "sent";

	const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } =
		useAutoScroll({
			smooth: true,
		});

	// Load messages from local storage on initial render
	useEffect(() => {
		const storedMessages = getMessagesFromLocalStorage(agentId);
		if (storedMessages.length > 0) {
			queryClient.setQueryData(["messages", agentId], storedMessages);
		}
	}, [agentId, queryClient]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
	useEffect(() => {
		scrollToBottom();
	}, [queryClient.getQueryData(["messages", agentId])]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
	useEffect(() => {
		scrollToBottom();
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (e.nativeEvent.isComposing) return;
			handleSendMessage(e as unknown as React.FormEvent<HTMLFormElement>);
		}
	};

	const handleSendMessage = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!input) return;

		const attachments: IAttachment[] | undefined = selectedFile
			? [
					{
						url: URL.createObjectURL(selectedFile),
						contentType: selectedFile.type,
						title: selectedFile.name,
					},
				]
			: undefined;

		const newMessages = [
			{
				text: input,
				user: "user",
				createdAt: Date.now(),
				attachments,
			},
			{
				text: input,
				user: "system",
				isLoading: true,
				createdAt: Date.now(),
			},
		];

		const updatedMessages = [
			...(queryClient.getQueryData<ContentWithUser[]>(["messages", agentId]) ||
				[]),
			...newMessages,
		];

		queryClient.setQueryData(["messages", agentId], updatedMessages);

		// Save to local storage
		saveMessagesToLocalStorage(agentId, updatedMessages as ContentWithUser[]);

		sendMessageMutation.mutate({
			message: input,
			selectedFile: selectedFile ? selectedFile : null,
		});

		setSelectedFile(null);
		setInput("");
		formRef.current?.reset();
	};

	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.focus();
		}
	}, []);

	const sendMessageMutation = useMutation({
		mutationKey: ["send_message", agentId],
		mutationFn: ({
			message,
			selectedFile,
		}: {
			message: string;
			selectedFile?: File | null;
		}) => apiClient.sendMessage(agentId, message, selectedFile),
		onSuccess: (newMessages: ContentWithUser[]) => {
			const currentMessages =
				queryClient.getQueryData<ContentWithUser[]>(["messages", agentId]) ||
				[];
			const updatedMessages = [
				...currentMessages.filter((msg) => !msg.isLoading),
				...newMessages.map((msg) => ({
					...msg,
					createdAt: Date.now(),
				})),
			];

			queryClient.setQueryData(["messages", agentId], updatedMessages);

			// Save to local storage
			saveMessagesToLocalStorage(agentId, updatedMessages);
		},
		onError: (e) => {
			toast({
				variant: "destructive",
				title: "Unable to send message",
				description: e.message,
			});
		},
	});

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file?.type.startsWith("image/")) {
			setSelectedFile(file);
		}
	};

	const joinRoomQuery = useQuery({
		queryKey: ["joinRoom", agentId],
		queryFn: () => apiClient.joinRoom(agentId),
		enabled: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const { data: latestMessage } = useQuery({
		queryKey: ["lastMessage", agentId],
		queryFn: () => apiClient.getMemories(agentId),
		refetchInterval: 5000,
		select: (data) => {
			if (data.memories.length === 0 && !joinRoomQuery.isSuccess) {
				joinRoomQuery.refetch();
			}

			const existingMessages =
				queryClient.getQueryData<ContentWithUser[]>(["messages", agentId]) ||
				[];

			// Filter out messages that already exist in our cache
			const newMessages = data.memories.reverse().filter(
				// biome-ignore lint/suspicious/noExplicitAny: <explanation>
				(newMsg: any) =>
					!existingMessages.some(
						// biome-ignore lint/suspicious/noExplicitAny: <explanation>
						(existingMsg: any) => existingMsg.id === newMsg.id,
					),
			);

			if (newMessages.length > 0) {
				// If we have new messages, add them to our messages
				const updatedMessages = [
					...existingMessages,
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					...newMessages.map((msg: any) => ({
						...msg,
						text: msg.content.text,
						user: msg.userId === "user" ? "user" : msg.agentId,
						attachments: msg.content.attachments || [],
					})),
				];

				// Deduplicate messages
				const deduplicatedMessages = deduplicateMessages(updatedMessages);

				// Update the query cache
				queryClient.setQueryData(["messages", agentId], deduplicatedMessages);

				// Save to local storage
				saveMessagesToLocalStorage(agentId, deduplicatedMessages);

				// Return the deduplicated messages
				return deduplicatedMessages;
			}

			return existingMessages;
		},
	});

	const messages = latestMessage || [];

	const transitions = useTransition(messages, {
		keys: (message) => `${message.createdAt}-${message.user}-${message.text}`,
		from: { opacity: 0, transform: "translateY(50px)" },
		enter: { opacity: 1, transform: "translateY(0px)" },
		leave: { opacity: 0, transform: "translateY(10px)" },
	});

	const CustomAnimatedDiv = animated.div as React.FC<AnimatedDivProps>;

	return (
		<div className="flex flex-col w-full h-[calc(100dvh)] p-4">
			<div className="flex-1 overflow-y-auto">
				<ChatMessageList
					scrollRef={scrollRef}
					isAtBottom={isAtBottom}
					scrollToBottom={scrollToBottom}
					disableAutoScroll={disableAutoScroll}
				>
					{transitions((style, message: ContentWithUser) => {
						const variant = getMessageVariant(message?.user);
						return (
							<CustomAnimatedDiv
								style={{
									...style,
									display: "flex",
									flexDirection: "column",
									gap: "0.5rem",
									padding: "1rem",
								}}
							>
								<ChatBubble
									variant={variant}
									className="flex flex-row items-center gap-2"
								>
									{message?.user !== "user" ? (
										<Avatar className="size-8 p-1 border rounded-full select-none">
											<AvatarImage src="/favicon-32x32.png" />
										</Avatar>
									) : null}
									<div className="flex flex-col">
										<ChatBubbleMessage isLoading={message?.isLoading}>
											{message?.user !== "user" ? (
												<AIWriter>{message?.text}</AIWriter>
											) : (
												message?.text
											)}
											{/* Attachments */}
											<div>
												{message?.attachments?.map(
													// biome-ignore lint/suspicious/noExplicitAny: <explanation>
													(attachment: any, _idx: any) => (
														<div
															className="flex flex-col gap-1 mt-2"
															key={`${attachment.url}-${attachment.title}`}
														>
															<img
																alt="attachment"
																src={attachment.url}
																width="100%"
																height="100%"
																className="w-64 rounded-md"
															/>
															<div className="flex items-center justify-between gap-4">
																<span />
																<span />
															</div>
														</div>
													),
												)}
											</div>
										</ChatBubbleMessage>
										<div className="flex items-center gap-4 justify-between w-full mt-1">
											{message?.text && !message?.isLoading ? (
												<div className="flex items-center gap-1">
													<CopyButton text={message?.text} />
													<ChatTtsButton
														agentId={agentId}
														text={message?.text}
													/>
												</div>
											) : null}
											<div
												className={cn([
													message?.isLoading ? "mt-2" : "",
													"flex items-center justify-between gap-4 select-none",
												])}
											>
												{message?.source ? (
													<Badge variant="outline">{message.source}</Badge>
												) : null}
												{message?.action ? (
													<Badge variant="outline">{message.action}</Badge>
												) : null}
												{message?.createdAt ? (
													<ChatBubbleTimestamp
														timestamp={moment(message?.createdAt).format("LT")}
													/>
												) : null}
											</div>
										</div>
									</div>
								</ChatBubble>
							</CustomAnimatedDiv>
						);
					})}
				</ChatMessageList>
			</div>
			<div className="px-4 pb-4">
				<form
					ref={formRef}
					onSubmit={handleSendMessage}
					className="relative rounded-md border bg-card"
				>
					{selectedFile ? (
						<div className="p-3 flex">
							<div className="relative rounded-md border p-2">
								<Button
									onClick={() => setSelectedFile(null)}
									className="absolute -right-2 -top-2 size-[22px] ring-2 ring-background"
									variant="outline"
									size="icon"
								>
									<X />
								</Button>
								<img
									alt="Selected file"
									src={URL.createObjectURL(selectedFile)}
									height="100%"
									width="100%"
									className="aspect-square object-contain w-16"
								/>
							</div>
						</div>
					) : null}
					<ChatInput
						ref={inputRef}
						onKeyDown={handleKeyDown}
						value={input}
						onChange={({ target }) => setInput(target.value)}
						placeholder="Type your message here..."
						className="min-h-12 resize-none rounded-md bg-card border-0 p-3 shadow-none focus-visible:ring-0"
					/>
					<div className="flex items-center p-3 pt-0">
						<Tooltip>
							<TooltipTrigger asChild>
								<div>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => {
											if (fileInputRef.current) {
												fileInputRef.current.click();
											}
										}}
									>
										<Paperclip className="size-4" />
										<span className="sr-only">Attach file</span>
									</Button>
									<input
										type="file"
										ref={fileInputRef}
										onChange={handleFileChange}
										accept="image/*"
										className="hidden"
									/>
								</div>
							</TooltipTrigger>
							<TooltipContent side="left">
								<p>Attach file</p>
							</TooltipContent>
						</Tooltip>
						<AudioRecorder
							agentId={agentId}
							onChange={(newInput: string) => setInput(newInput)}
						/>
						<Button
							disabled={!input || sendMessageMutation?.isPending}
							type="submit"
							size="sm"
							className="ml-auto gap-1.5 h-[30px]"
						>
							{sendMessageMutation?.isPending ? "..." : "Send Message"}
							<Send className="size-3.5" />
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
