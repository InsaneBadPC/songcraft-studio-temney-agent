import { supabase } from "@/lib/supabase";
import { createAssistantRequest, type AssistantHistoryMessage } from "./assistant-chat-payload";

export type StudioAssistantMessage = AssistantHistoryMessage;
export { createAssistantRequest } from "./assistant-chat-payload";

export async function askStudioAssistant(message: string, history: StudioAssistantMessage[]) {
  const payload = createAssistantRequest(message, history);
  const agent = await supabase.functions.invoke("agent-orchestrator", { body: payload });
  if (!agent.error) {
    const agentAnswer = (agent.data as { answer?: unknown } | null)?.answer;
    if (typeof agentAnswer === "string" && agentAnswer.trim()) return agentAnswer.trim();
  }
  const { data, error } = await supabase.functions.invoke("songcraft-studio-assistant", { body: payload });
  if (error) throw new Error(error.message || agent.error?.message || "Asistent nyní není dostupný.");
  const answer = (data as { answer?: unknown } | null)?.answer;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("Asistent nevrátil odpověď.");
  return answer.trim();
}
