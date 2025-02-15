import { app } from "electron";
import fs from "fs/promises";
import path from "path";
import process from "process";
import {
  BLOCK_SPECS_FILE_NAME,
  PIPELINE_SPECS_FILE_NAME,
} from "../src/utils/constants";
import { filterDirectories } from "./fileSystem.js";
import { checkAndUpload, checkAndCopy, uploadDirectory } from "./s3.js";
import { createExecution, getBuildContextStatus } from "./anvil";
import { logger } from "./logger";
import { computePipelineMerkleTree } from "./merkle";
import { fileExists } from "./fileSystem.js";
import { cacheJoin } from "./cache";
import { ensureGitRepoAndCommitBlocks } from "./git.js";

export const convertToUnixPath = (inputPath) => {
  // Normalize the path to handle mixed separators
  let normalizedPath = inputPath.replace(/\\/g, "/");

  // Remove any duplicate slashes
  normalizedPath = normalizedPath.replace(/\/+/g, "/");

  // Remove trailing slash if it exists (unless it's the root path)
  if (normalizedPath.length > 1 && normalizedPath.endsWith("/")) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  // Ensure path starts with a forward slash
  if (!normalizedPath.startsWith("/")) {
    normalizedPath = "/" + normalizedPath;
  }

  return normalizedPath;
};
export async function saveSpec(spec, writePath) {
  const pipelineSpecsPath = path.join(writePath, PIPELINE_SPECS_FILE_NAME);
  await fs.mkdir(writePath, { recursive: true });
  await fs.writeFile(pipelineSpecsPath, JSON.stringify(spec, null, 2));
}

export async function saveBlock(blockKey, blockSpec, fromPath, toPath) {
  const newFolder = path.join(toPath, blockKey);
  logger.debug(`saving ${blockKey} from ${fromPath} to ${newFolder}`);
  await fs.mkdir(newFolder, { recursive: true });
  await fs.cp(fromPath, newFolder, { recursive: true });
  await fs.writeFile(
    path.join(newFolder, BLOCK_SPECS_FILE_NAME),
    JSON.stringify(blockSpec, null, 2),
  );
  return newFolder;
}

//added a helper function to know if a block is a parameter block
function hasParameter(blockSpec) {
  return blockSpec && blockSpec.action && blockSpec.action.parameters;
}

function hasContainer(blockSpec) {
  return blockSpec.action.container || blockSpec.action.pipeline;
}

export async function copyPipeline(pipelineSpecs, fromDir, toDir) {
  const bufferPath = path.resolve(process.cwd(), fromDir);

  // Takes existing pipeline + spec
  const writePipelineDirectory = toDir;
  const pipelineSpecsPath = path.join(
    writePipelineDirectory,
    PIPELINE_SPECS_FILE_NAME,
  );

  const fromBlockIndex = await getBlockIndex([bufferPath]);

  if (!(await fileExists(writePipelineDirectory))) {
    try {
      await fs.mkdir(writePipelineDirectory, { recursive: true });
    } catch (error) {
      console.log(`Directory ${writePipelineDirectory} already exists`);
    }
  }

  // Gets pipeline specs from the specs coming from the graph
  // Submitted by the client
  const newPipelineBlocks = getPipelineBlocks(pipelineSpecs);

  for (const key of Array.from(newPipelineBlocks)) {
    const newBlockPath = path.join(writePipelineDirectory, key);
    let existingBlockPath = fromBlockIndex[key];
    const blockSpec = pipelineSpecs.pipeline[key];
    if (!existingBlockPath) {
      // NOTE: BAD KEY
      // At a certain point we serialized non unique keys
      // for folder names so there's a chance that we will
      // fail to find the correct key and need to fall back
      // to fetching a common folder name

      existingBlockPath = fromBlockIndex[blockSpec.information.id];
    }
    if (!existingBlockPath) {
      // If we still can't find a path
      // we try to fall back to the block source path
      existingBlockPath = blockSpec.information.block_source;
      if (app.isPackaged) {
        existingBlockPath = path.join(process.resourcesPath, existingBlockPath);
      }
    }

    if (existingBlockPath != newBlockPath) {
      // if it's the same folder, don't try to copy it
      await fs.cp(existingBlockPath, newBlockPath, { recursive: true });
      await fs.writeFile(
        path.join(newBlockPath, BLOCK_SPECS_FILE_NAME),
        JSON.stringify(blockSpec, null, 2),
      );
    }
  }

  await fs.writeFile(pipelineSpecsPath, JSON.stringify(pipelineSpecs, null, 2));

  return { specs: PIPELINE_SPECS_FILE_NAME, dirPath: writePipelineDirectory };
}

async function getBlockIndex(blockDirectories) {
  const blockIndex = {};
  for (const directory of blockDirectories) {
    try {
      const blockPaths = await getBlocksInDirectory(directory);
      for (const blockPath of blockPaths) {
        const normPath = path.normalize(blockPath);
        const blockId = normPath.split(path.sep).pop();
        blockIndex[blockId] = blockPath;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        // TODO: fetching the actual block will fix this
        const message = `Directory or file does not exist: ${error.path}`;
        logger.warn(error, message);
      } else {
        // Handle other types of errors or rethrow the error
        throw error;
      }
    }
  }
  return blockIndex;
}

function getPipelineBlocks(pipelineSpecs) {
  const blocks = new Set();
  const pipeline = pipelineSpecs.pipeline;
  for (const [key, block] of Object.entries(pipeline)) {
    if (hasContainer(block) && !hasParameter(block)) {
      blocks.add(key);
    }
  }
  return blocks;
}

async function getBlocksInDirectory(directory) {
  const files = await fs.readdir(directory);
  const filePaths = files.map((b) => path.join(directory, b));
  const directories = await filterDirectories(filePaths);

  return directories;
}

// async function readPipelineBlocks(specsPath) {
//   const specs = await readJsonToObject(specsPath);
//   return getPipelineBlocks(specs);
// }

export async function removeBlock(blockId, pipelinePath) {
  const blockPath = await getPipelineBlockPath(pipelinePath, blockId);
  fs.rm(blockPath, { recursive: true });
}

export async function getPipelineBlockPath(pipelinePath, blockId) {
  const blockPaths = await getBlocksInDirectory(pipelinePath);

  for (const blockPath of blockPaths) {
    const id = blockPath.split(path.sep).pop();
    if (blockId == id) {
      return blockPath;
    }
  }
}

export async function executePipeline(
  id,
  executionId,
  specs,
  pipelinePath,
  name,
  rebuild,
  anvilHostConfiguration,
) {
  specs = await uploadBlocks(id, executionId, specs, anvilHostConfiguration);
  specs["sink"] = pipelinePath;
  specs["build"] = pipelinePath;
  specs["name"] = name;
  specs["id"] = id;

  const merkleTree = await computePipelineMerkleTree(specs, pipelinePath);

  await uploadBuildContexts(
    anvilHostConfiguration,
    specs,
    merkleTree,
    pipelinePath,
    executionId,
  );

  return await createExecution(
    anvilHostConfiguration,
    executionId,
    specs,
    merkleTree,
    rebuild,
  );
}

async function uploadBlocks(
  pipelineId,
  executionId,
  pipelineSpecs,
  anvilConfiguration,
) {
  const nodes = pipelineSpecs.pipeline;
  for (const nodeId in nodes) {
    const node = nodes[nodeId];

    const parameters = node.action?.parameters;

    if (parameters) {
      for (const paramKey in parameters) {
        const param = parameters[paramKey];

        if (param.type === "file" || param.type == "fileLoad") {
          const filePath = param.value;
          const fileName = path.basename(filePath);
          const awsKey = `${pipelineId}/${executionId}/${fileName}`;

          if (filePath && filePath.trim()) {
            await checkAndUpload(awsKey, filePath, anvilConfiguration);
            param.value = `"${fileName}"`;
            param.type = "blob";
          }
        } else if (param.type == "file[]") {
          const files = param.value;
          const uploaded = await Promise.all(
            files.map(async (filePath) => {
              const fileName = path.basename(filePath);
              const awsKey = `${pipelineId}/${executionId}/${fileName}`;
              if (filePath && filePath.trim()) {
                await checkAndUpload(awsKey, filePath, anvilConfiguration);
              }
              return fileName;
            }),
          );

          param.value = JSON.stringify(uploaded);
          param.type = "blob[]";
        } else if (param.type === "folder") {
          const files = param?.value ?? [];
          const folder = parameters?.folderName?.value;
          if (!folder || folder == "") {
            throw new Error("Folder block must set a folderName parameter");
          }
          const uploaded = await Promise.all(
            files.map(async (filePath) => {
              const unixPath = convertToUnixPath(filePath);
              const folderIndex = unixPath.indexOf(folder);
              if (folderIndex === -1) {
                throw new Error("Folder block must set a folderName parameter");
              }
              const slicePath = unixPath.slice(folderIndex);
              const awsKey = `${pipelineId}/${executionId}/${slicePath}`;
              if (unixPath && unixPath.trim()) {
                await checkAndUpload(awsKey, filePath, anvilConfiguration);
              }
              return slicePath;
            }),
          );
          param.value = JSON.stringify(uploaded);
          param.type = "folderBlob";
        } else if (param.type == "blob") {
          const copyKey = param.value;
          const fileName = param.value.split("/").at(-1);
          const newAwsKey = `${pipelineId}/${executionId}/${fileName}`;
          await checkAndCopy(newAwsKey, copyKey, anvilConfiguration);
          param.value = `"${fileName}"`;
        } else if (param.type == "blob[]") {
          const s3files = param.value;
          const uploadedFiles = await Promise.all(
            s3files.map(async (s3file) => {
              const fileName = s3file.split("/").at(-1);
              const newAwsKey = `${pipelineId}/${executionId}/${fileName}`;
              await checkAndCopy(newAwsKey, s3file, anvilConfiguration);
              return fileName;
            }),
          );

          param.value = JSON.stringify(uploadedFiles);
          param.type = "blob[]";
        } else if (param.type == "folderBlob") {
          const folder = parameters?.folderName?.value;
          if (!folder || folder == "") {
            throw new Error("Folder block must set a folderName parameter");
          }
          const awsPaths = param?.value ?? [];
          const uploadedFiles = await Promise.all(
            awsPaths.map(async (s3file) => {
              const folderIndex = s3file.indexOf(folder);
              if (folderIndex === -1) {
                throw new Error("Folder block must set a folderName parameter");
              }
              const slicePath = s3file.slice(folderIndex);
              const newAwsKey = `${pipelineId}/${executionId}/${slicePath}`;
              await checkAndCopy(newAwsKey, s3file, anvilConfiguration);
              return slicePath;
            }),
          );
          param.value = JSON.stringify(uploadedFiles);
        }
      }
    }
  }
  return pipelineSpecs;
}

async function uploadBuildContexts(
  configuration,
  pipelineSpecs,
  pipelineMerkleTree,
  buildPath,
  executionId,
) {
  const buildContextStatuses = await getBuildContextStatus(
    configuration,
    pipelineSpecs,
    pipelineMerkleTree,
    false,
  );
  const pipelineCache = cacheJoin(pipelineSpecs.id);
  await ensureGitRepoAndCommitBlocks(
    buildContextStatuses,
    buildPath,
    pipelineCache,
    executionId,
  );
  await Promise.all(
    buildContextStatuses
      .filter((status) => !status.isUploaded)
      .map((status) => [path.join(buildPath, status.blockKey), status.s3Key])
      .map(([blockPath, s3Key]) =>
        uploadDirectory(s3Key, blockPath, configuration),
      ),
  );
}
