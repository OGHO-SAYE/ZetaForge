import { useState } from "react";
import useFileBuffer from "./useFileBuffer";

export default function useFileHandle(pipelinePath, blockId) {
  const [currentFile, setCurrentFile] = useState();
  const isComputation = currentFile?.name === "computations.py";
  const isSelected = Boolean(currentFile);
  const buffer = useFileBuffer(
    pipelinePath,
    blockId,
    currentFile?.relativePath,
  );

  const set = async (file) => {
    setCurrentFile(file);
    if (file.read) {
      await buffer.load(file.relativePath);
    }
  };

  return {
    ...currentFile,
    buffer,
    set,
    isComputation,
    isSelected,
  };
}