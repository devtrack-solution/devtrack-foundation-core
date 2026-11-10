import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/**
 * LocalStack é o recurso AWS autorizado para testes (decisão D5). Não é conta AWS
 * real: a diferença é registrada em validation.md. A porta do contêiner é efêmera.
 */
/**
 * Tag fixada na última série Community que roda sem token. A tag `latest` (2026.x)
 * exige LOCALSTACK_AUTH_TOKEN e encerra com código 55; não usar credenciais aqui.
 */
export const LOCALSTACK_IMAGE = 'localstack/localstack:3.8';
export const LOCALSTACK_PORT = 4566;
export const LOCALSTACK_REGION = 'us-east-1';

export async function startLocalStack(): Promise<StartedTestContainer> {
  try {
    return await new GenericContainer(LOCALSTACK_IMAGE)
      .withEnvironment({ SERVICES: 's3' })
      .withExposedPorts(LOCALSTACK_PORT)
      .withWaitStrategy(Wait.forHttp('/_localstack/health', LOCALSTACK_PORT))
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker did not respond to Testcontainers (LocalStack S3). Make sure the Docker daemon is running and the image ${LOCALSTACK_IMAGE} can be pulled. Cause: ${cause}`,
    );
  }
}

export function localStackEndpoint(container: StartedTestContainer): string {
  return `http://${container.getHost()}:${container.getMappedPort(LOCALSTACK_PORT)}`;
}
