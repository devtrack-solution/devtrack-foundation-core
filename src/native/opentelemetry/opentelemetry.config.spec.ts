import {
  OpenTelemetryConfigError,
  readOpenTelemetryConfig,
} from './opentelemetry.config';

const VALID = {
  FOUNDATION_SERVICE_NAME: 'foundation-api',
  FOUNDATION_SERVICE_VERSION: '1.0.0',
  FOUNDATION_DEPLOYMENT_ENVIRONMENT: 'staging',
};

describe('OpenTelemetry host configuration', () => {
  it('reads service identity from the host environment', () => {
    expect(readOpenTelemetryConfig(VALID)).toEqual({
      serviceName: 'foundation-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'staging',
    });
  });

  it('fails closed when an identity field is missing and does not echo the value', () => {
    const { FOUNDATION_SERVICE_VERSION: _omit, ...rest } = VALID;
    void _omit;
    expect(() => readOpenTelemetryConfig(rest)).toThrow(
      OpenTelemetryConfigError,
    );
    expect(() =>
      readOpenTelemetryConfig({
        ...VALID,
        FOUNDATION_SERVICE_NAME: 'bad name with secret',
      }),
    ).toThrow('FOUNDATION_SERVICE_NAME');
    try {
      readOpenTelemetryConfig({
        ...VALID,
        FOUNDATION_SERVICE_NAME: 'bad name with secret',
      });
    } catch (error) {
      expect((error as Error).message).not.toContain('bad name');
    }
  });
});
