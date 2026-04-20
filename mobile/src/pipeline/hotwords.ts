/**
 * Medical French hotwords for sherpa-onnx contextual biasing.
 *
 * Format: one term per line, optional boost score.
 * Higher boost = stronger preference during beam search.
 *
 * These terms are written to a file on device and passed to
 * createStreamingSTT({ hotwordsFile }) to bias the transducer
 * decoder toward medical vocabulary.
 */

export const HOTWORDS_CONTENT = `
pipéracilline 3.5
tazobactam 3.5
noradrénaline 3.5
adrénaline 3.0
vasopressine 3.0
amiodarone 3.0
metformine 3.0
ceftriaxone 3.0
insuline 2.5
héparine 2.5
morphine 2.5
paracétamol 2.5
ibuprofène 2.5
oméprazole 2.5
pantoprazole 2.5
furosémide 2.5
propofol 2.5
midazolam 2.5
fentanyl 2.5
kétamine 2.5
vancomycine 3.0
méropénème 3.0
ciprofloxacine 2.5
amoxicilline 2.5
clindamycine 2.5
métronidazole 2.5
fluconazole 2.5
acétylcystéine 3.0
sandostatine 3.0
dobutamine 3.0
dopamine 2.5
atropine 2.5
digoxine 2.5
warfarine 2.5
rivaroxaban 2.5
énoxaparine 2.5
prednisone 2.5
dexaméthasone 2.5
hydrocortisone 2.5
hémodynamiquement 3.0
hémodynamique 3.0
pneumocoque 3.0
insuffisance 2.0
cardiogène 2.5
néphrotique 2.5
hépatomégalie 2.5
septicémie 2.5
bactériémie 2.5
pneumonie 2.0
embolie 2.5
thrombose 2.5
fibrillation 2.5
auriculaire 2.0
tachycardie 2.5
bradycardie 2.5
hypotension 2.0
hypertension 2.0
hyperkaliémie 2.5
hypokaliémie 2.5
hyponatrémie 2.5
acidose 2.5
alcalose 2.5
rhabdomyolyse 3.0
pancréatite 2.5
cholécystite 2.5
péritonite 2.5
méningite 2.5
endocardite 2.5
péricardite 2.5
myocardite 2.5
ischémie 2.5
infarctus 2.5
hémorragie 2.0
coagulopathie 3.0
thrombopénie 2.5
anémie 2.0
diabète 2.0
cirrhose 2.5
encéphalopathie 3.0
cathéter 2.5
dialyse 2.5
hémodialyse 3.0
intubation 2.5
ventilation 2.0
antibiothérapie 2.5
anticoagulation 2.5
thrombolyse 3.0
endoscopie 2.5
échographie 2.5
tomodensitométrie 3.0
transfusion 2.5
hémoglobine 2.5
créatinine 2.5
bilirubine 2.5
troponine 2.5
procalcitonine 3.0
lactate 2.5
glycémie 2.5
gazométrie 2.5
volémique 2.5
cristalloïdes 2.5
vasoactif 2.5
aminergique 2.5
inotrope 2.5
vasoplégie 3.0
pneumothorax 2.5
épanchement 2.0
dyspnée 2.5
oligurie 2.5
réanimation 2.0
sédation 2.5
catécholamines 2.5
Pseudomonas 3.0
aeruginosa 3.0
Staphylococcus 3.0
Escherichia 3.0
Klebsiella 3.0
pneumoniae 3.0
bicarbonate 2.5
sodium 2.0
albumine 2.5
`.trim();
