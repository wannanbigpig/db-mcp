export interface TestableConnector {
  testConnection(): Promise<boolean>;
}

export async function isConnectorHealthy(connector: TestableConnector | null): Promise<boolean> {
  if (!connector) {
    return false;
  }

  try {
    return await connector.testConnection();
  } catch {
    return false;
  }
}
