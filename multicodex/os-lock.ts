import koffi from "koffi";

let flock: ((fd: number, operation: number) => number) | undefined;

/** Acquire a nonblocking, descriptor-held OS lock; false means contention.
 * Linux and macOS both provide flock(2), even without a flock executable.
 * Closing the descriptor (including on process death) releases ownership.
 */
export function flockExclusive(fd: number): boolean {
	if (process.platform !== "linux" && process.platform !== "darwin") {
		throw new Error(`OS locking is unsupported on ${process.platform}`);
	}
	flock ??= koffi.load(null).func("int flock(int fd, int operation)");
	// LOCK_EX | LOCK_NB have the same values on Linux and macOS.
	for (;;) {
		if (flock(fd, 2 | 4) === 0) return true;
		const errno = koffi.errno();
		if (errno === koffi.os.errno.EINTR) continue;
		if (
			errno === koffi.os.errno.EWOULDBLOCK ||
			errno === koffi.os.errno.EAGAIN
		) {
			return false;
		}
		throw new Error(`flock(2) failed (errno ${errno})`);
	}
}
