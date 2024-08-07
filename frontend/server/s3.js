import {
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import fs from "fs/promises";
import config from "../config";
import { getDirectoryFilesRecursive } from "./fileSystem";
import path from "path";
import { logger } from "./logger";

function getClient(configuration) {
  const endpoint = `http://${configuration.s3.host}:${configuration.s3.port}`;
  return new S3Client({
    region: configuration.s3.region,
    credentials: {
      accessKeyId: configuration.s3.accessKeyId,
      secretAccessKey: configuration.s3.secretAccessKey,
    },
    endpoint: endpoint,
    forcePathStyle: config.s3.forcePathStyle,
  });
}

export async function checkAndCopy(newKey, copyKey, anvilConfiguration) {
  const oldExists = await fileExists(copyKey, anvilConfiguration);
  if (!oldExists) {
    throw new Error(
      "Previous file did not upload successfully, please upload a new file.",
    );
  }
  const exists = await fileExists(newKey, anvilConfiguration);
  if (!exists) {
    await copy(newKey, copyKey, anvilConfiguration);
  }
}

async function copy(newKey, copyKey, anvilConfiguration) {
  const client = getClient(anvilConfiguration);
  const source = encodeURI(`/${config.s3.bucket}/${copyKey}`);
  try {
    const res = await client.send(
      new CopyObjectCommand({
        Bucket: config.s3.bucket,
        CopySource: source,
        Key: newKey,
      }),
    );

    return res;
  } catch (err) {
    const message = `Could not copy file in S3 from ${source} to ${newKey}`;
    logger.error(message, err, err?.stack);
    throw new Error(message);
  }
}

export async function checkAndUpload(key, filePath, anvilConfiguration) {
  const exists = await fileExists(key, anvilConfiguration);

  if (!exists) {
    await upload(key, filePath, anvilConfiguration);
  }
}

export async function uploadDirectory(key, diretoryPath, anvilConfiguration) {
  const files = await getDirectoryFilesRecursive(diretoryPath);
  await Promise.all(
    files.map((f) =>
      upload(
        `${key}/${f.replace(path.sep, "/")}`,
        path.join(diretoryPath, f),
        anvilConfiguration,
      ),
    ),
  );
}

async function upload(key, filePath, anvilConfiguration) {
  const client = getClient(anvilConfiguration);

  try {
    const fileBody = await fs.readFile(filePath);
    const res = await client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: fileBody,
      }),
    );
    return res;
  } catch (err) {
    const message = "Could not upload file to S3";
    logger.error(message, err, err.stack);
    throw new Error(message);
  }
}

async function fileExists(key, anvilConfiguration) {
  const client = getClient(anvilConfiguration);

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      }),
    );
    return true;
  } catch (err) {
    if (err.name === "NotFound") {
      return false;
    }
    const message = "Error checking file existence in S3";
    logger.error(message, err, err.stack);
    throw new Error(message);
  }
}

export async function getFileData(key, anvilConfiguration) {
  const exists = await fileExists(key, anvilConfiguration);
  const client = getClient(anvilConfiguration);

  if (exists) {
    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.s3.bucket,
          Key: key,
        }),
      );

      const fileData = await response.Body.transformToString();
      return fileData;
    } catch (err) {
      const message = "Could not retrieve file from S3";
      logger.error(message, err);
      throw new Error(message);
    }
  } else {
    logger.debug(`File with key ${key} does not exist in S3`);
    return null;
  }
}

export async function getFile(key, destinationPath, anvilConfiguration) {
  const client = getClient(anvilConfiguration);
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      }),
    );

    const fileStream = fs.createWriteStream(destinationPath);
    response.Body.pipe(fileStream);

    await new Promise((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });

    logger.debug(`File downloaded successfully to ${destinationPath}`);
  } catch (err) {
    const message = "Could not download file from S3";
    logger.error(message, err);
    throw new Error(message);
  }
}
