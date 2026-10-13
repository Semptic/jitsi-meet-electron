export {};

/**
 * The API exposed on {@code window} by the preload script
 * ({@code app/preload/preload.ts}).
 */
interface IJitsiElectronApp {
    embeddedClient: {
        resolve(serverURL: string): Promise<{ origin: string; } | null>;
    };
    ipc: {
        addListener(channel: string, listener: (...args: any[]) => void): (() => void) | undefined;
        send(channel: string, ...args: any[]): void;
    };
    multitrack: {
        abort(fileId: string): Promise<void>;
        chooseDirectory(): Promise<{ name: string; token: string; } | null>;
        close(fileId: string): Promise<void>;
        openFile(token: string, name: string): Promise<{ fileId: string; }>;
        write(fileId: string, data: ArrayBuffer, position?: number): Promise<{ size: number; }>;
    };
    openExternalLink(url: string): void;
}

declare global {
    interface Window {
        jitsiElectronApp: IJitsiElectronApp;
        renderEntryPoint(entryPoint: string): void;
    }

    namespace NodeJS {
        interface Process {

            /**
             * Set by Electron in Mac App Store builds.
             */
            mas?: boolean;
        }
    }
}
