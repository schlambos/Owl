export type { ConfigMutation } from "@omo/shared";
export type ServerConfig = {
  host: string;
  port: number;
  opencodeConfigDir: string;
  projectDirectory: string;
  authorizedRoots: string[];
};
