export { AwsS3Module, AWS_S3_OBJECT_STORAGE } from './aws-s3.module';
export type { AwsS3AsyncOptions } from './aws-s3.module';
export { S3ObjectStorage, createS3ObjectStorage } from './aws-s3.adapter';
export type { AwsS3Transport } from './aws-s3.adapter';
export {
  AWS_S3_DEFAULT_CONTENT_TYPES,
  AWS_S3_DEFAULT_MAX_OBJECT_BYTES,
  AWS_S3_MAX_OBJECT_BYTES_LIMIT,
  AwsS3ConfigError,
  resolveAwsS3Options,
} from './aws-s3.options';
export type {
  AwsS3Options,
  AwsS3ServerSideEncryption,
  ResolvedAwsS3Options,
} from './aws-s3.options';
export {
  AWS_S3_MODULE_DESCRIPTOR,
  AWS_S3_MODULE_ID,
} from './aws-s3.descriptor';
