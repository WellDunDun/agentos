import { useEffect, useState } from "react";

let listener: ((message: string) => void) | undefined;

export function toast(message: string): void {
	listener?.(message);
}

export function Toaster() {
	const [message, setMessage] = useState<string | null>(null);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		listener = (m) => {
			setMessage(m);
			clearTimeout(timer);
			timer = setTimeout(() => setMessage(null), 4200);
		};
		return () => {
			listener = undefined;
			clearTimeout(timer);
		};
	}, []);
	return <div className={`toast${message ? " show" : ""}`}>{message}</div>;
}
