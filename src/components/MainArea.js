import WhisperDictation from "./WhisperDictation";

const MainArea = () => {
    return (
        <div className="flex justify-center items-center min-h-screen">
            <div className="container flex flex-col justify-center items-center px-4">
                <h1 className="text-5xl font-extrabold tracking-tight text-slate-900 sm:text-7xl text-center">
                    Kassandra Vox
                </h1>
                <h2 className="mt-3 mb-5 px-4 text-center text-xl font-semibold tracking-tight text-slate-500 sm:text-2xl">
                    French Medical Dictation
                </h2>

                <WhisperDictation />
            </div>
        </div>
    );
};

export default MainArea;
