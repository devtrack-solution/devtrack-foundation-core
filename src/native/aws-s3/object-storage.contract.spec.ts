import { InMemoryObjectStorage } from '../../../test/fixtures/aws-s3-object-storage/in-memory-object-storage';
import { describeObjectStorageContract } from '../../../test/fixtures/aws-s3-object-storage/object-storage.contract';

// Mesma suíte que test/aws-s3.e2e-spec.ts executa contra o adapter S3 em LocalStack.
describeObjectStorageContract(
  'duplo em memória',
  () => new InMemoryObjectStorage(),
);
