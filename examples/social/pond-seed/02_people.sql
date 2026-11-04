-- 300 people in six teams across four cities.
CREATE OR REPLACE TABLE demo.social.people AS
SELECT
  i AS id,
  -- (i * 7) % 300 visits every slot once, so each person gets a unique name.
  ['Ada','Bo','Cyd','Dee','Eli','Fay','Gus','Hal','Ivy','Jo','Kai','Lu','Max','Nia','Oli','Pia','Rex','Sam','Tea','Uma'][1 + (i * 7) % 300 % 20]
    || ' ' ||
  ['Berg','Dahl','Ek','Falk','Holm','Lind','Lund','Nord','Ros','Sand','Sjo','Strom','Vik','Wall','Ahl'][1 + (i * 7) % 300 // 20] AS name,
  ['Data','Platform','Design','Sales','Support','Research'][1 + i % 6] AS team,
  ['Stockholm','Gothenburg','Malmo','Remote'][1 + (hash(i, 'city') % 4)::INT] AS city,
  2015 + (hash(i, 'year') % 11)::INT AS joined
FROM range(300) t(i);
