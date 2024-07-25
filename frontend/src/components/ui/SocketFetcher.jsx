import { useAtom } from "jotai";
import { pipelineAtom } from "@/atoms/pipelineAtom";
import { useEffect, useCallback } from "react";
import { useStableWebSocket } from "@/hooks/useStableWebsocket";
import { useUnifiedLogs } from "@/hooks/useUnifiedLogs";
import { parseLogLine } from "@/atoms/logsAtom";
import { enableMapSet } from "immer";

enableMapSet();

export default function SocketFetcher() {
  const [pipeline, setPipeline] = useAtom(pipelineAtom);
  const { lastMessage, readyState, wsError } = useStableWebSocket(
    pipeline?.socketUrl,
  );

  const { updateLogs } = useUnifiedLogs();

  const updateNodes = useCallback((parsedLogEntry) => {
    setPipeline((draft) => {
      if (draft?.data[parsedLogEntry?.blockId.slice(6)]) {
        const node = draft.data[parsedLogEntry?.blockId.slice(6)];
        if (
          parsedLogEntry?.event?.tag === "outputs" ||
          parsedLogEntry?.event?.tag === "inputs"
        ) {
          try {
            node.events[parsedLogEntry.event?.tag] = parsedLogEntry.event?.data;
          } catch (err) {
            console.error(`Failed to parse ${parsedLogEntry.event?.tag}:`, err);
          }
        }
      }
    });
  });

  useEffect(() => {
    if (lastMessage !== null) {
      const content = JSON.parse(lastMessage?.data)?.content;
      if (content) {
        updateLogs([content]);

        const parsedLogEntry = parseLogLine(content);
        if (!parsedLogEntry?.blockId) {
          return;
        }
        // Update pipeline state if needed
        updateNodes(parsedLogEntry);
      }
    }
  }, [lastMessage, updateLogs, setPipeline]);

  return null;
}